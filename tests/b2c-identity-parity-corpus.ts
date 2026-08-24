/**
 * Names run through BOTH the TypeScript and SQL canonicalization, which must
 * produce byte-identical output. Add a case here whenever a new class of
 * character appears in real customer data -- this corpus is the only thing
 * standing between a canonicalization change and a silent duplicate payment.
 */
export const identityParityCorpus = [
  "Maya Al Khalifa",
  "hoor alshubbar",
  "  Reham   Garash  ",
  "MAYA AL KHALIFA",
  "José García",
  "Müller",
  "Ḥasan Ibn Sīnā",
  "Łukasz Nowak",
  "Ærik Ø",
  "Ahmad Al-Sayed",
  "محمّد عبدالله",
  "O'Brien",
  "Jean-Luc Picard",
] as const;
