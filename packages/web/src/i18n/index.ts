import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";

import jaTranslation from "./locales/ja/translation.json";
import enTranslation from "./locales/en/translation.json";
import zhTWTranslation from "./locales/zh-TW/translation.json";
import zhHKTranslation from "./locales/zh-HK/translation.json";
import idTranslation from "./locales/id/translation.json";

const resources = {
  ja: { translation: jaTranslation },
  en: { translation: enTranslation },
  "zh-TW": { translation: zhTWTranslation },
  "zh-HK": { translation: zhHKTranslation },
  id: { translation: idTranslation },
};

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: "ja",
    supportedLngs: ["ja", "en", "zh-TW", "zh-HK", "id"],
    load: "currentOnly",
    interpolation: {
      escapeValue: false,
    },
    detection: {
      order: ["querystring", "localStorage", "navigator"],
      lookupQuerystring: "lang",
      lookupLocalStorage: "i18nextLng",
      caches: ["localStorage"],
    },
  });

export default i18n;
