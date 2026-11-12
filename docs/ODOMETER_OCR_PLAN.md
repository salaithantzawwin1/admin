# Plan — Odometer OCR cross-check (hybrid)

**Goal:** the number a driver types is never silently wrong, and the backlog of
trips whose reading was never keyed can be filled from the photos we already have.

**Status:** plan only — not implemented. Estimate: 1 day for the cross-check,
+0.5 day for the Administration backfill screen, once a vision key exists.

---

## 1. Why (evidence from the live system, 2026-11-10)

| Fact | Source |
|---|---|
| The bot never reads the photo — the driver types the number; the photo is only evidence (`handleOdoText` accepts `^\d{1,7}$`) | `backend/src/telegram/telegram.service.ts` |
| The typed number and the photo are never compared | no OCR/vision code anywhere in `backend/src` |
| CAR-202611-0023: the departure photo reads **341,324**, the driver typed **341,325** — a 1 km error that becomes a permanent monthly total | the photo, re-read by hand |
| 76 assignments ever, **2** with both readings; 2026-10 has **57** trips with no reading | `car_assignments`, `GET /api/cars/usage` |

So: a typo is invisible and the monthly distance is quietly wrong, and the
unrecorded backlog is far too large to key in by hand.

## 2. Design decision — verification, never extraction

OCR **never** becomes the source of truth. The driver still types the number
(fast, offline-safe, no dependency); the reader only **checks** it:

```
photo arrives ─► store pending (done: P8) ─► read the LCD region ─► odoReadKm
driver types 341363 ─┬─ read == typed  → record, mark odoCheckedAt (auto-confirmed)
                     └─ read != typed  → confirm card:
                          "ဓာတ်ပုံမှာ 341,324 — သင်ရိုက်သည်မှာ 341,363 — ဘယ်ဟာ မှန်လဲ?"
                          [✓ ဓာတ်ပုံအတိုင်း] [✏️ ငါရိုက်တာအတိုင်း]
```

Reasons to keep it hybrid rather than OCR-only:
- A wrong reading is permanent (`usage = end - start`) — a human/ driver check is cheap.
- The reader can be wrong: glare, a dirty lens, the ODO/TRIP toggle, two different
  dashboards in the fleet (seen: Toyota Succeed, Grand Starex, Probox, Minicab).
- No key, no internet, or a provider outage must degrade to today's behaviour, never block a trip.

## 3. Provider

Three options; recommendation is **B**, with **A** as the offline fallback.

| | How | Accuracy (this fleet) | Cost / photo | Notes |
|---|---|---|---|---|
| **A. Tesseract, offline** | crop the LCD strip, whitelist `0123456789`, 7-seg template per dashboard | ~50–70% | free | needs a per-model template; maintenance heavy |
| **B. Vision LLM (recommended)** | send the cropped LCD strip, ask for the ODO digits only | ~90%+ | ~$0.001–0.002 (≈ 2–5 MMK) | provider-agnostic: OpenAI / Gemini / Claude; ~100 photos/month is trivial |
| C. Hybrid A+B | B normally, A when the key is missing/offline | — | — | most work, best resilience |

Provider access needed from the server (it already reaches the internet —
Telegram polling works). Key stored in `system_settings` (never in code, chat,
logs or the browser), read through `SettingsService` like the bot token.

**Settings** (all optional; absence = feature off):
`odometer.ocr.enabled` (bool), `odometer.ocr.provider` (`openai` | `gemini` | `anthropic`),
`odometer.ocr.api_key`, `odometer.ocr.model`, `odometer.ocr.daily_limit` (cost guard).

## 4. Where it lives in the code

New `backend/src/cars/odometer-reader.service.ts`:

```ts
@Injectable()
export class OdometerReaderService {
  /** null = no key, disabled, provider error, or unreadable photo. Never throws. */
  async read(photo: { buffer: Buffer; size: number }): Promise<{ km: number; confidence: 'high' | 'low' } | null>;
}
```

- Input: the stored pending photo (already on disk — P8 made this possible).
- Crop the bottom-centre LCD band (~x 0.38–0.72, y 0.60–0.78 of the frame) and
  upscale 2×; fall back to the full frame when the crop reads nothing.
- Prompt: *"This is a car dashboard. Reply with ONLY the ODO value as digits
  (the number labelled ODO, not TRIP and not the clock). If unreadable, reply
  NONE."* Temperature 0, `max_tokens` ~10.
- Post-parse: digits only, 4–7 chars, plausible vs the vehicle's `currentMileage`
  (reject a reading lower than the last recorded return — it is a TRIP reading).
- Timeout 8 s, one retry, then give up. Cache by photo file hash so a re-send or a
  confirm tap does not pay twice.

## 5. Data model

On `car_assignments` (next to the pending columns added for P8):

```prisma
odoReadKm         Int?      // what the reader saw
odoReadAt         DateTime?
odoReadSource     String?   // 'llm' | 'tesseract' | 'manual'
odoReadConfidence String?   // 'high' | 'low'
odoCheckedAt      DateTime? // the typed number was verified against the photo
```

Audit: extend `CAR_ODOMETER_RECORDED` with `{ readKm, matched: boolean }` so the
Audit Logs screen answers "was this number ever checked?".

## 6. Flows

1. **Driver, photo first (normal).** Photo arrives → stored (done) → reader runs in
   the background (not on the driver's critical path). Number arrives →
   match → record as today + `odoCheckedAt`; mismatch → the confirm card, and the
   chosen value is recorded with `odoReadSource`/`matched` in the audit trail.
2. **Driver, number first (P7 path).** The number is already kept on the row; the
   photo that follows is confirmed by the driver — the reader's value is shown in
   that card too ("ဓာတ်ပုံမှာ 341,324 / သင်ရိုက်သည် 341,363").
3. **Administration backfill screen (the 57-trip backlog).** In the usage tab, a
   "📷 readings missing (57)" list: for each row, the kept/Telegram photo, the
   reader's guess pre-filled in the number field, and one **Confirm** button
   (still one click per trip, but no typing and no hunting for the photo).
   Where the photo is gone (older than the pending TTL) the row falls back to
   "photo unavailable — enter manually", which is today's flow.
4. **Nothing else changes.** If the reader is unavailable, every path behaves
   exactly as it does now.

## 7. Failure modes and guards

| Case | Behaviour |
|---|---|
| No key / disabled | reader returns null, flow unchanged |
| Provider error / timeout | one retry, then null; a warning log, never a driver-visible error |
| Two numbers in frame (ODO + TRIP) | prompt names ODO; a value below the last return is rejected |
| Reading below `currentMileage` | flagged as `low` confidence, still shown to the human |
| Cost | per-day counter in `system_settings`; over `odometer.ocr.daily_limit` → skip and log |
| Privacy | only the cropped LCD strip is sent; no driver, plate or chat data; the response is never stored beyond the parsed digits |

## 8. Testing

- Unit with a fake provider: match, mismatch, unreadable, timeout, key absent,
  rate limit — the flow must be identical to today's when the reader is null.
- Golden images: the three photos from 2026-11-10 (341,324 / 341,325 / 341,363)
  as fixtures; assert the reader extracts the ODO and not the clock or TRIP.
- Confirm card: ✓ records the typed number, ✏️ records the reader's, both audited.
- Backfill screen: a 57-row list renders, one confirm writes through the real
  `captureOdometer` guards (photo required, return ≥ departure).

## 9. Rollout

1. Shadow mode (`enabled: true`, `mode: log-only`): the reader runs on every photo
   and only writes the audit line. Two weeks of real photos tell us the true
   accuracy before any driver sees it.
2. Driver-facing mismatch card.
3. Administration backfill screen for the backlog.
4. Optional later: an OCR-only mode for vehicles whose dashboard is reliably read
   (driver just sends the photo) — only after shadow mode shows near-perfect accuracy.

## 10. Open questions

- Which provider/key will be used? (Needed before step 1 of the rollout.)
- Should a mismatch *block* recording until the driver answers, or record the
  typed number and flag it? (Plan assumes: ask first, record on the answer.)
- Do we want per-dashboard crop templates (better accuracy) or the generic crop
  plus a strong prompt (less maintenance)?

## Engine evaluation: offline options (Nov 2026)

Constraint measured on the AMS host: it reaches PyPI only. Docker Hub, the Debian
apt mirrors and the Paddle model CDN are all blocked, so a Tesseract install (apt)
and a PaddleOCR install (the framework downloads its weights from bcebos) cannot be
done on this server as it stands.

RapidOCR — the same PP-OCR detection/recognition models on ONNX Runtime, weights
bundled in the wheel, installable from PyPI alone — was installed and benchmarked
against the six real driver photos in /app/uploads/odometer (four distinct readings:
341324, 341324, 341325, 341363).

Result: 0 of 4 correct. The detector finds the "ODO" label confidently (0.93), but
the recogniser then returns confident nonsense for the digits (52E16E000, ESEIHE000,
HAR2), and returns nothing at all from a tight, 4x-upscaled crop of the digit strip.
The single correct read came from a centre crop of the sharpest photo — luck, not
repeatable.

Cause: seven-segment LCD digits are not printed text. PP-OCR and Tesseract recognise
model glyphs trained on printed type; the dashboards add glare, motion blur and JPEG
noise on top, and the digits are only ~30px tall in the frame.

Conclusion: keep the reader engine-agnostic through the provider setting and do not
switch to a classical OCR engine. The viable paths, cheapest first:

1. Human-in-the-loop confirmation — already implemented (number-first capture plus
   the photo confirm card). Zero cost, no new failure modes.
2. A free-tier multimodal model key (provider=gemini is already supported). No spend,
   and multimodal models are the family that actually reads these dashboards.
3. A dedicated seven-segment pipeline — LCD region from the ODO/clock anchor, then
   per-digit segmentation and a digit classifier trained on this fleet's dashboards.
   Free at runtime and fully offline, but a real project: it needs 100+ labelled
   crops and its own accuracy validation before it can cross-check anything.

Verdict on "PaddleOCR first, Tesseract as backup": not achievable on this host
(both install paths are blocked) and not accurate enough on seven-segment displays.
Tesseract would carry the same seven-segment gap on top of the missing binary.
---

## 6. Offline seven-segment reader (implemented, 2026-11-12)

**No key, no internet.** `provider=local` uses `backend/src/cars/odometer-7seg/`
and a classifier made of digit glyphs cut from photos an administrator labelled.
Why not Tesseract/PaddleOCR: section 5 — both are install-blocked on this host and
both read these seven-segment panels badly (PP-OCR reported `52E16E000` for a
clean `341325`).

### Pipeline

| Stage | File | What it does |
|---|---|---|
| decode | `image.ts` | JPEG/PNG → greyscale (WebP stays unreadable, by design) |
| cluster | `lcd.ts` `findCluster()` | biggest bright blob in the frame = the instrument cluster; a bright wall or window is rejected on aspect |
| anchor | `lcd.ts` `anchorRoi()` | ODO digit row inside the cluster: the **median of labelled rows** when available, the fleet's geometric prior otherwise |
| segment | `segment.ts` `segmentDigits()` | Otsu, both polarities (unlit LCD = dark digits, backlit = bright digits), keeps the tall blobs (drops fuel bars/clock), splits blobs two digits share, 16×24 contrast-stretched patch each |
| classify | `classify.ts` | nearest neighbour over stored templates per digit; accepts only when similarity ≥ 0.82 **and** the winner beats the runner-up by ≥ 0.03 |

A doubtful photo returns `null`: a miss is fine, a confident wrong number is not.

### Training (what "label real photos" means)

`GET /api/cars/odometer/training/photos` → stored dashboard photos (cars.assign).
`POST /api/cars/odometer/training/analyze` → the LCD row + the cut glyphs (PNG
previews) for one photo. `POST /api/cars/odometer/training/label {km}` → stores one
`odometer_digit_samples` row per glyph plus an `odometer_lcd_calibrations` row for
the row position. Frontend: **Odometer Training** in the sidebar.

Nothing is stored from an unlabelled photo, and a label whose digit count differs
from the glyphs the reader cut is rejected with the count it saw (label a steadier
photo instead).

### Turning it on

```
odometer.ocr.enabled  = true
odometer.ocr.provider = local      # no api_key needed
odometer.ocr.mode     = shadow
```

`stats.ready` (≥ 60 glyphs, ≥ 3 per digit) is the point where a read is worth
trusting; below that expect misses, not mistakes. Shadow mode is unchanged: only
`odoReadKm` + the audit line are written, the driver's number is untouched.
