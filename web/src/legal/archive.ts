/**
 * Every version of the Terms of use as published, oldest first: the plain text is served from
 * web/public/legal, and `sha256` is the SHA-256 of that file. For the version in force it is also the
 * fingerprint of the Terms as the site shows them with the default legal settings (from 2.1: none set,
 * and the legal contact support@visionswap.net; see legal/settings.ts DEFAULT_LEGAL_SETTINGS and
 * legal/terms-doc.ts termsHash), which is what web/test/terms.test.ts checks.
 *
 * A new version: change lib/terms.ts (TERMS_VERSION, TERMS_EFFECTIVE, TERMS_CHANGES), add its row
 * here, then run `npm run terms:archive -w web`, which writes its text file and its sha256. Never
 * change or remove an older row or its file: they are the record of what people accepted.
 */
export type ArchivedTerms = {
  version: string;
  /** YYYY-MM-DD: when it was last updated (version 1) or took effect */
  date: string;
  /** served at this address */
  file: string;
  sha256: string;
  /** how the Terms page describes an earlier version */
  note: string;
};

export const TERMS_ARCHIVE: readonly ArchivedTerms[] = [
  {
    version: "1.0",
    date: "2026-10-14",
    file: "/legal/terms-1.0.txt",
    sha256: "1fdd1a3b815f48a97006df6a44678769231efe2333eec939c0a3188587ad30c4",
    note: "the version in force before 2.0",
  },
  {
    version: "2.0",
    date: "2026-10-15",
    file: "/legal/terms-2.0.txt",
    sha256: "d596cdccb35692cc297ef209a74c749e0ee6cafca823b6ff0aa2f143eb376fd9",
    note: "the version in force before 2.1",
  },
  {
    version: "2.1",
    date: "2026-10-15",
    file: "/legal/terms-2.1.txt",
    sha256: "90fcb100dbd5458517602f060fcd345373b72ba6f7022c9074d0552ff6b0854b",
    note: "in force",
  },
];
