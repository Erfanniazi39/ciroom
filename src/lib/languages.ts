/** Subtitle languages CiRoom can search for (codes are the subtitle service's). Persian and English first. */
export const SUBTITLE_LANGUAGES: { code: string; name: string }[] = [
  { code: "FA", name: "Persian" },
  { code: "EN", name: "English" },
  { code: "AR", name: "Arabic" },
  { code: "TR", name: "Turkish" },
  { code: "FR", name: "French" },
  { code: "ES", name: "Spanish" },
  { code: "DE", name: "German" },
  { code: "RU", name: "Russian" },
  { code: "IT", name: "Italian" },
  { code: "HI", name: "Hindi" },
  { code: "JA", name: "Japanese" },
  { code: "KO", name: "Korean" },
  { code: "ZH", name: "Chinese" },
  { code: "NL", name: "Dutch" },
  { code: "PL", name: "Polish" },
];
export const languageName = (code: string) => SUBTITLE_LANGUAGES.find((l) => l.code === code)?.name ?? code;
