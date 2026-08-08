const translationKeys = ["translatedText", "translated_text", "message", "text"] as const;

const unwrapCodeFence = (value: string): string => {
  const match = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(value);
  return match?.[1]?.trim() ?? value;
};

export const normalizeTranslationText = (value: string): string => {
  const trimmed = value.trim();
  const candidate = unwrapCodeFence(trimmed);

  try {
    const parsed: unknown = JSON.parse(candidate);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return trimmed;
    const record = parsed as Record<string, unknown>;
    for (const key of translationKeys) {
      const text = record[key];
      if (typeof text === "string" && text.trim().length > 0) return text.trim();
    }
  } catch {
    return trimmed;
  }

  return trimmed;
};
