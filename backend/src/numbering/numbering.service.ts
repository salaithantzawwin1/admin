import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.module';

@Injectable()
export class NumberingService {
  constructor(private prisma: PrismaService) {}

  /**
   * Allocate the next document number, e.g. CAR-202609-0007 (year + month).
   * Key is per prefix+yearMonth so numbering resets monthly (plan §8).
   * Uses an atomic upsert+increment inside a transaction to avoid duplicates.
   *
   * `yearDigits` 2 prints only the last two digits of the year (AST-2610-0001
   * instead of AST-202610-0001) while the sequence key keeps the full year, so
   * old and new rows still share one monthly counter.
   */
  async next(prefix: string, when: Date = new Date(), yearDigits: 2 | 4 = 4): Promise<string> {
    const year = when.getFullYear();
    const month = String(when.getMonth() + 1).padStart(2, '0');
    const key = `${prefix}-${year}${month}`;
    const stamp = yearDigits === 2 ? `${String(year).slice(-2)}${month}` : `${year}${month}`;

    return this.prisma.$transaction(async (tx) => {
      // atomic counter bump; row is created with counter=1 on first use
      const [row] = await tx.$queryRaw<Array<{ counter: number }>>`
        INSERT INTO document_sequences ("id", "key", "counter", "updatedAt")
        VALUES (gen_random_uuid(), ${key}, 1, now())
        ON CONFLICT ("key") DO UPDATE SET "counter" = "document_sequences"."counter" + 1, "updatedAt" = now()
        RETURNING "counter"
      `;
      const seq = Number(row.counter);
      return `${prefix}-${stamp}-${String(seq).padStart(4, '0')}`;
    });
  }

  /**
   * Allocate the next asset code, e.g. AST-PRI-2611-0010.
   * The register has ONE continuous counter: the YYMM stamp still follows the
   * issue date, but the number no longer restarts at 0001 when the month
   * changes — AST-PRI-2611-0009 is followed by AST-ITE-2612-0010.
   * The counter is seeded on first use from the highest 4-digit tail already in
   * the register, so codes minted under the old monthly-reset rule continue
   * where they left off instead of starting over.
   */
  async nextAssetCode(prefix: string, when: Date = new Date()): Promise<string> {
    const stamp = `${String(when.getFullYear()).slice(-2)}${String(when.getMonth() + 1).padStart(2, '0')}`;
    return this.prisma.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<Array<{ counter: number }>>`
        INSERT INTO document_sequences ("id", "key", "counter", "updatedAt")
        VALUES (
          gen_random_uuid(),
          'AST-SEQ',
          COALESCE((
            SELECT MAX(substring("assetCode" from '([0-9]{4})$')::int)
            FROM assets
            WHERE "assetCode" ~ '([0-9]{4})$'
          ), 0) + 1,
          now()
        )
        ON CONFLICT ("key") DO UPDATE
          SET "counter" = "document_sequences"."counter" + 1, "updatedAt" = now()
        RETURNING "counter"
      `;
      return `${prefix}-${stamp}-${String(Number(row.counter)).padStart(4, '0')}`;
    });
  }

  /**
   * Allocate the next number from a stable (never-resetting) sequence —
   * e.g. nextStable('ITM') → "ITM-0042". Used for codes that must stay unique
   * forever, unlike the monthly-reset document numbers above.
   * A single atomic statement makes concurrent creates safe (no duplicate codes):
   * on the very first use the counter is seeded from the max numeric suffix
   * already present in inventory_items, so legacy ITM-#### codes are honoured.
   */
  async nextStable(prefix: string): Promise<string> {
    return this.prisma.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<Array<{ counter: number }>>`
        INSERT INTO document_sequences ("id", "key", "counter", "updatedAt")
        VALUES (
          gen_random_uuid(),
          ${prefix}::text,
          COALESCE((
            SELECT MAX(NULLIF(regexp_replace(code, '\\D', '', 'g'), '')::int)
            FROM inventory_items WHERE code LIKE ${prefix + '-%'}
          ), 0) + 1,
          now()
        )
        ON CONFLICT ("key") DO UPDATE
          SET "counter" = "document_sequences"."counter" + 1, "updatedAt" = now()
        RETURNING "counter"
      `;
      return `${prefix}-${String(Number(row.counter)).padStart(4, '0')}`;
    });
  }
}
