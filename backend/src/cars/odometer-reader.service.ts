import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.module';
import { AuditService } from '../audit/audit.service';

/**
 * Odometer OCR — shadow mode (plan: docs/ODOMETER_OCR_PLAN.md).
 *
 * The driver still types the number; this service only READS the photo and says
 * what it saw, so the typed number can be checked against the evidence. It never
 * records a reading, never blocks a flow and never throws: with no key, no
 * internet or a provider outage the whole feature is a no-op and the capture
 * behaves exactly as before.
 *
 * Shadow mode (default) writes `odoReadKm` + an audit line only. `mode=enforce`
 * is reserved for the phase where the driver is shown a mismatch card — this
 * service still does not decide anything, the caller does.
 */

const KEY_ENABLED = 'odometer.ocr.enabled';
const KEY_MODE = 'odometer.ocr.mode';
const KEY_PROVIDER = 'odometer.ocr.provider';
const KEY_API_KEY = 'odometer.ocr.api_key';
const KEY_MODEL = 'odometer.ocr.model';
const KEY_BASE_URL = 'odometer.ocr.base_url';
const KEY_DAILY_LIMIT = 'odometer.ocr.daily_limit';

/** The whole job of the prompt: ODO digits, not the clock and not the TRIP meter. */
const PROMPT = [
  'This is a photo of a car dashboard.',
  'Reply with ONLY the number labelled ODO (the total odometer), as digits with no separators.',
  'Ignore the clock and the TRIP meter.',
  'If you cannot read the ODO value clearly, reply exactly: NONE',
].join(' ');

const DEFAULT_MODEL: Record<string, string> = {
  openai: 'gpt-4o-mini',
  gemini: 'gemini-2.0-flash',
  anthropic: 'claude-3-5-haiku-latest',
};

const DEFAULT_BASE: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
  anthropic: 'https://api.anthropic.com',
};

export interface OdometerRead {
  km: number;
  /** 'low' when the number is below what the car already recorded — likely a TRIP reading */
  confidence: 'high' | 'low';
  source: string;
}

interface ReaderSettings {
  enabled: boolean;
  mode: 'shadow' | 'enforce';
  provider: string;
  apiKey: string | null;
  model: string;
  baseUrl: string;
  dailyLimit: number;
}

@Injectable()
export class OdometerReaderService {
  private readonly logger = new Logger(OdometerReaderService.name);
  /** A slow provider must not hold a photo (or a request) hostage. */
  private static readonly TIMEOUT_MS = 8000;

  constructor(private prisma: PrismaService, private audit: AuditService) {}

  /**
   * Read the ODO value out of a dashboard photo. null = feature off, no key,
   * unreadable, over the daily budget, or the provider failed — never an error.
   */
  async read(photo: { buffer: Buffer; size?: number }): Promise<OdometerRead | null> {
    const cfg = await this.settings();
    if (!cfg.enabled || !cfg.apiKey) return null;
    if (!photo?.buffer?.length) return null;
    try {
      if (cfg.dailyLimit > 0) {
        const used = await this.prisma.carAssignment
          .count({ where: { odoReadAt: { gte: this.startOfDay() } } })
          .catch(() => 0);
        if (used >= cfg.dailyLimit) {
          this.logger.warn(`odometer OCR daily limit (${cfg.dailyLimit}) reached — skipping`);
          return null;
        }
      }
      const text = await this.ask(cfg, photo.buffer);
      const km = this.parse(text);
      if (km == null) return null;
      return { km, confidence: 'high', source: cfg.provider };
    } catch (e) {
      // an observer must never disturb the capture
      this.logger.warn(`odometer read failed: ${(e as Error).message}`);
      return null;
    }
  }

  /**
   * Read a photo that was just kept for an assignment and store what was seen.
   * Called fire-and-forget from the Telegram photo path; in shadow mode this is
   * the entire feature — no driver ever sees it.
   */
  async readAndRecord(assignmentId: string, photo: { buffer: Buffer; size?: number }): Promise<OdometerRead | null> {
    const cfg = await this.settings();
    if (!cfg.enabled) return null;
    const read = await this.read(photo);
    if (!read) return null;
    try {
      const row = await this.prisma.carAssignment
        .findUnique({
          where: { id: assignmentId },
          select: { requestId: true, vehicle: { select: { currentMileage: true } } },
        })
        .catch(() => null);
      // odometers only go up: a number under the car's own last reading is either
      // a TRIP value or someone else's dashboard — keep it, but say so
      const floor = row?.vehicle?.currentMileage ?? 0;
      const confidence: 'high' | 'low' = read.km >= floor ? read.confidence : 'low';
      await this.prisma.carAssignment.update({
        where: { id: assignmentId },
        data: {
          odoReadKm: read.km,
          odoReadAt: new Date(),
          odoReadSource: read.source,
          odoReadConfidence: confidence,
        },
      });
      await this.audit
        .log({
          username: 'odometer-ocr',
          action: 'CAR_ODOMETER_OCR_READ',
          module: 'CARS',
          recordId: row?.requestId ?? assignmentId,
          newValue: { km: read.km, confidence, source: read.source, mode: cfg.mode, floor } as never,
        })
        .catch(() => undefined);
      return { ...read, confidence };
    } catch (e) {
      this.logger.warn(`could not store the odometer read: ${(e as Error).message}`);
      return null;
    }
  }

  // ------------------------------------------------------------------

  private async settings(): Promise<ReaderSettings> {
    const keys = [KEY_ENABLED, KEY_MODE, KEY_PROVIDER, KEY_API_KEY, KEY_MODEL, KEY_BASE_URL, KEY_DAILY_LIMIT];
    const rows: Array<{ key: string; value: string | null }> = await this.prisma.systemSetting
      .findMany({ where: { key: { in: keys } } })
      .catch(() => []);
    const get = (k: string) => {
      const v = rows.find((r) => r.key === k)?.value;
      return v == null ? null : String(v).trim() || null;
    };
    const provider = (get(KEY_PROVIDER) ?? 'openai').toLowerCase();
    return {
      enabled: (get(KEY_ENABLED) ?? 'false').toLowerCase() === 'true',
      mode: (get(KEY_MODE) ?? 'shadow').toLowerCase() === 'enforce' ? 'enforce' : 'shadow',
      provider,
      apiKey: get(KEY_API_KEY),
      model: get(KEY_MODEL) ?? DEFAULT_MODEL[provider] ?? DEFAULT_MODEL.openai,
      baseUrl: (get(KEY_BASE_URL) ?? DEFAULT_BASE[provider] ?? DEFAULT_BASE.openai).replace(/\/+$/, ''),
      dailyLimit: Number(get(KEY_DAILY_LIMIT) ?? 0) || 0,
    };
  }

  private startOfDay(): Date {
    // the office runs on Asia/Yangon time (UTC+6:30)
    const now = new Date(Date.now() + 6.5 * 3600 * 1000);
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 6.5 * 3600 * 1000);
  }

  /** One provider call. Returns the raw text the model produced. */
  private async ask(cfg: ReaderSettings, buffer: Buffer): Promise<string> {
    const b64 = buffer.toString('base64');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OdometerReaderService.TIMEOUT_MS);
    try {
      if (cfg.provider === 'gemini') {
        const res = await fetch(
          `${cfg.baseUrl}/models/${encodeURIComponent(cfg.model)}:generateContent?key=${encodeURIComponent(cfg.apiKey ?? '')}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: PROMPT }, { inline_data: { mime_type: 'image/jpeg', data: b64 } }] }],
              generationConfig: { temperature: 0, maxOutputTokens: 16 },
            }),
            signal: controller.signal,
          },
        );
        if (!res.ok) throw new Error(`gemini HTTP ${res.status}`);
        const json: any = await res.json();
        const parts = json?.candidates?.[0]?.content?.parts;
        return Array.isArray(parts) ? parts.map((p: any) => String(p?.text ?? '')).join(' ') : '';
      }
      if (cfg.provider === 'anthropic') {
        const res = await fetch(`${cfg.baseUrl}/v1/messages`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': cfg.apiKey ?? '',
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: cfg.model,
            max_tokens: 16,
            temperature: 0,
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } },
                  { type: 'text', text: PROMPT },
                ],
              },
            ],
          }),
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`anthropic HTTP ${res.status}`);
        const json: any = await res.json();
        const blocks = json?.content;
        return Array.isArray(blocks) ? blocks.map((b: any) => String(b?.text ?? '')).join(' ') : '';
      }
      // OpenAI-compatible (openai, and any local gateway that speaks the same shape)
      const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey ?? ''}` },
        body: JSON.stringify({
          model: cfg.model,
          temperature: 0,
          max_tokens: 16,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: PROMPT },
                { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } },
              ],
            },
          ],
        }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`ocr provider HTTP ${res.status}`);
      const json: any = await res.json();
      return String(json?.choices?.[0]?.message?.content ?? '');
    } finally {
      clearTimeout(timer);
    }
  }

  /** Strict on purpose: 4–7 digits, no clock values, no prose. */
  private parse(text: string): number | null {
    const raw = String(text ?? '').trim();
    if (!raw) return null;
    if (/^none\b/i.test(raw)) return null;
    const match = raw.match(/\d[\d,.\s]{2,9}\d/);
    const digits = (match ? match[0] : raw).replace(/[^\d]/g, '');
    if (digits.length < 4 || digits.length > 7) return null;
    const km = Number(digits);
    return Number.isFinite(km) && km > 0 ? km : null;
  }
}
