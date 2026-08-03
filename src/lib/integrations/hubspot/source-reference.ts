/** Makes a stored HubSpot source reference readable in Admin review screens. */
export function hubSpotDealNameForDisplay(sourceReference: string | null): string {
  if (!sourceReference) return "Legacy issue — no deal reference was captured.";
  const match = /^HubSpot deal\s+[^—]+—\s+(.+)$/.exec(sourceReference);
  return match?.[1]?.trim() || sourceReference;
}
