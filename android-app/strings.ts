// Every text on the Connect screen, in English and Persian. `{host}` is replaced by the address (always left-to-right).

export type Lang = "en" | "fa";

const en = {
  tagline: "Your movies and series, on your phone.",
  scan: "Scan QR code",
  scanHint: "Point the camera at the QR code on your PC: CiRoom → Settings → Phone remote.",
  or: "or",
  addressLabel: "PC address",
  addressPlaceholder: "192.168.1.20",
  connect: "Connect",
  open: "Open {host}",
  forget: "Forget this PC",
  connecting: "Connecting to {host}…",
  cancel: "Cancel",
  tryAgain: "Try again",
  changePc: "Change PC",
  errUnreachable: "Can't reach your PC. Is CiRoom open, Phone remote on, and are you on the same Wi-Fi?",
  errOff: "The phone remote is off on your PC. Turn it on in CiRoom → Settings → Phone remote.",
  errOther: "Something else answers at this address.",
  errBadQr: "This isn't a CiRoom code. Use the QR code in CiRoom → Settings → Phone remote.",
  errBadAddress: "That isn't a home-network address. Type something like 192.168.1.20 (or 192.168.1.20:1420).",
  errCamera: "The camera isn't allowed. Allow it in the phone's settings, or type the address.",
  errScan: "Couldn't scan. Try again, or type the address.",
  errUnpaired: "This phone isn't paired with your PC yet. Scan the QR code in CiRoom → Settings → Phone remote.",
  updateAvailable: "CiRoom {v} is available",
  download: "Download",
  later: "Later",
};

const fa: typeof en = {
  tagline: "فیلم‌ها و سریال‌هایت، روی گوشی.",
  scan: "اسکن کد QR",
  scanHint: "دوربین را روی کد QR رایانه بگیر: CiRoom ← تنظیمات ← ریموت گوشی.",
  or: "یا",
  addressLabel: "نشانی رایانه",
  addressPlaceholder: "192.168.1.20",
  connect: "اتصال",
  open: "باز کردن {host}",
  forget: "فراموش کردن این رایانه",
  connecting: "در حال اتصال به {host}…",
  cancel: "انصراف",
  tryAgain: "تلاش دوباره",
  changePc: "تغییر رایانه",
  errUnreachable: "به رایانه‌ات وصل نشد. CiRoom باز است؟ ریموت گوشی روشن است؟ و هر دو به یک وای‌فای وصل‌اند؟",
  errOff: "ریموت گوشی روی رایانه خاموش است. در CiRoom ← تنظیمات ← ریموت گوشی روشنش کن.",
  errOther: "در این نشانی برنامهٔ دیگری پاسخ می‌دهد.",
  errBadQr: "این کد CiRoom نیست. از کد QR در CiRoom ← تنظیمات ← ریموت گوشی استفاده کن.",
  errBadAddress: "این نشانی شبکهٔ خانگی نیست. مثلاً 192.168.1.20 (یا 192.168.1.20:1420) بنویس.",
  errCamera: "دسترسی به دوربین داده نشده. در تنظیمات گوشی اجازه بده یا نشانی را تایپ کن.",
  errScan: "اسکن نشد. دوباره تلاش کن یا نشانی را تایپ کن.",
  errUnpaired: "این گوشی هنوز به رایانه‌ات وصل (جفت) نشده. کد QR را اسکن کن: CiRoom ← تنظیمات ← ریموت گوشی.",
  updateAvailable: "نسخهٔ {v} از CiRoom آماده است",
  download: "دانلود",
  later: "بعداً",
};

export type Key = keyof typeof en;
export const STRINGS: Record<Lang, Record<Key, string>> = { en, fa };

/** Persian when the phone's language is Persian (`fa`, `fa-IR`), otherwise English. */
export function pickLang(language: string | undefined): Lang {
  return /^fa(\b|-|_)/i.test(language ?? "") ? "fa" : "en";
}
