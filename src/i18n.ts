import { app } from 'electron';
import path from 'path';
import log from 'electron-log/main';

const i18nLog = log.scope('i18n');

// --- Localised loading text ---
export const LOADING_TEXT: Record<string, string> = {
  'en': 'Loading...',
  'zh-CN': '加载中…',
  'zh-SG': '加载中…',
  'zh-TW': '載入中…',
  'zh-HK': '載入中…',
  'es': 'Cargando...',
  'hi': 'लोड हो रहा है...',
  'ar': 'جارٍ التحميل...',
  'fr': 'Chargement...',
  'pt': 'A carregar...',
  'de': 'Wird geladen...',
  'ru': 'Загрузка...',
  'ja': '読み込み中…',
  'ko': '로딩 중...',
  'it': 'Caricamento...',
  'nl': 'Laden...',
  'pl': 'Ładowanie...',
  'tr': 'Yükleniyor...',
  'sv': 'Läser in...',
  'da': 'Indlæser...',
  'fi': 'Ladataan...',
  'nb': 'Laster...',
  'no': 'Laster...',
  'cs': 'Načítání...',
  'ro': 'Se încarcă...',
  'hu': 'Betöltés...',
  'el': 'Φόρτωση...',
  'th': 'กำลังโหลด...',
  'id': 'Memuat...',
  'ms': 'Memuatkan...',
  'uk': 'Завантаження...',
  'vi': 'Đang tải...',
  'he': 'טוען...',
};

// --- "About {name}" ---
export const ABOUT_TEXT: Record<string, string> = {
  'en': 'About {name}',
  'zh-CN': '关于 {name}',
  'zh-SG': '关于 {name}',
  'zh-TW': '關於 {name}',
  'zh-HK': '關於 {name}',
  'es': 'Acerca de {name}',
  'hi': '{name} के बारे में',
  'ar': 'حول {name}',
  'fr': 'À propos de {name}',
  'pt': 'Sobre {name}',
  'de': 'Über {name}',
  'ru': 'О программе {name}',
  'ja': '{name} について',
  'ko': '{name} 정보',
  'it': 'Informazioni su {name}',
  'nl': 'Over {name}',
  'pl': 'O programie {name}',
  'tr': '{name} Hakkında',
  'sv': 'Om {name}',
  'da': 'Om {name}',
  'fi': 'Tietoja: {name}',
  'nb': 'Om {name}',
  'no': 'Om {name}',
  'cs': 'O aplikaci {name}',
  'ro': 'Despre {name}',
  'hu': 'A {name} névjegye',
  'el': 'Σχετικά με {name}',
  'th': 'เกี่ยวกับ {name}',
  'id': 'Tentang {name}',
  'ms': 'Perihal {name}',
  'uk': 'Про {name}',
  'vi': 'Giới thiệu về {name}',
  'he': 'אודות {name}',
};

// --- "Quit" ---
export const QUIT_TEXT: Record<string, string> = {
  'en': 'Quit',
  'zh-CN': '退出',
  'zh-SG': '退出',
  'zh-TW': '結束',
  'zh-HK': '結束',
  'es': 'Salir',
  'hi': 'बंद करें',
  'ar': 'إنهاء',
  'fr': 'Quitter',
  'pt': 'Sair',
  'de': 'Beenden',
  'ru': 'Выход',
  'ja': '終了',
  'ko': '종료',
  'it': 'Esci',
  'nl': 'Stop',
  'pl': 'Zakończ',
  'tr': 'Çıkış',
  'sv': 'Avsluta',
  'da': 'Afslut',
  'fi': 'Lopeta',
  'nb': 'Avslutt',
  'no': 'Avslutt',
  'cs': 'Ukončit',
  'ro': 'Ieșire',
  'hu': 'Kilépés',
  'el': 'Τερματισμός',
  'th': 'ออก',
  'id': 'Keluar',
  'ms': 'Keluar',
  'uk': 'Вийти',
  'vi': 'Thoát',
  'he': 'יציאה',
};

// --- "Close" ---
export const CLOSE_TEXT: Record<string, string> = {
  'en': 'Close',
  'zh-CN': '关闭',
  'zh-SG': '关闭',
  'zh-TW': '關閉',
  'zh-HK': '關閉',
  'es': 'Cerrar',
  'hi': 'बंद करें',
  'ar': 'إغلاق',
  'fr': 'Fermer',
  'pt': 'Fechar',
  'de': 'Schließen',
  'ru': 'Закрыть',
  'ja': '閉じる',
  'ko': '닫기',
  'it': 'Chiudi',
  'nl': 'Sluiten',
  'pl': 'Zamknij',
  'tr': 'Kapat',
  'sv': 'Stäng',
  'da': 'Luk',
  'fi': 'Sulje',
  'nb': 'Lukk',
  'no': 'Lukk',
  'cs': 'Zavřít',
  'ro': 'Închide',
  'hu': 'Bezárás',
  'el': 'Κλείσιμο',
  'th': 'ปิด',
  'id': 'Tutup',
  'ms': 'Tutup',
  'uk': 'Закрити',
  'vi': 'Đóng',
  'he': 'סגור',
};

// --- "Version" ---
export const VERSION_PREFIX: Record<string, string> = {
  'en': 'Version',
  'zh-CN': '版本',
  'zh-SG': '版本',
  'zh-TW': '版本',
  'zh-HK': '版本',
  'es': 'Versión',
  'hi': 'संस्करण',
  'ar': 'الإصدار',
  'fr': 'Version',
  'pt': 'Versão',
  'de': 'Version',
  'ru': 'Версия',
  'ja': 'バージョン',
  'ko': '버전',
  'it': 'Versione',
  'nl': 'Versie',
  'pl': 'Wersja',
  'tr': 'Sürüm',
  'sv': 'Version',
  'da': 'Version',
  'fi': 'Versio',
  'nb': 'Versjon',
  'no': 'Versjon',
  'cs': 'Verze',
  'ro': 'Versiunea',
  'hu': 'Verzió',
  'el': 'Έκδοση',
  'th': 'เวอร์ชัน',
  'id': 'Versi',
  'ms': 'Versi',
  'uk': 'Версія',
  'vi': 'Phiên bản',
  'he': 'גרסה',
};

// --- "All rights reserved." ---
export const COPYRIGHT_SUFFIX: Record<string, string> = {
  'en': 'All rights reserved.',
  'zh-CN': '保留所有权利。',
  'zh-SG': '保留所有权利。',
  'zh-TW': '保留所有權利。',
  'zh-HK': '保留所有權利。',
  'es': 'Todos los derechos reservados.',
  'hi': 'सर्वाधिकार सुरक्षित।',
  'ar': 'جميع الحقوق محفوظة.',
  'fr': 'Tous droits réservés.',
  'pt': 'Todos os direitos reservados.',
  'de': 'Alle Rechte vorbehalten.',
  'ru': 'Все права защищены.',
  'ja': 'All rights reserved.',
  'ko': '모든 권리 보유.',
  'it': 'Tutti i diritti riservati.',
  'nl': 'Alle rechten voorbehouden.',
  'pl': 'Wszelkie prawa zastrzeżone.',
  'tr': 'Tüm hakları saklıdır.',
  'sv': 'Alla rättigheter förbehållna.',
  'da': 'Alle rettigheder forbeholdes.',
  'fi': 'Kaikki oikeudet pidätetään.',
  'nb': 'Alle rettigheter forbeholdt.',
  'no': 'Alle rettigheter forbeholdt.',
  'cs': 'Všechna práva vyhrazena.',
  'ro': 'Toate drepturile rezervate.',
  'hu': 'Minden jog fenntartva.',
  'el': 'Με επιφύλαξη παντός δικαιώματος.',
  'th': 'สงวนลิขสิทธิ์',
  'id': 'Hak cipta dilindungi undang-undang.',
  'ms': 'Hak cipta terpelihara.',
  'uk': 'Усі права захищені.',
  'vi': 'Mọi quyền được bảo lưu.',
  'he': 'כל הזכויות שמורות.',
};

// --- "Licensed under" ---
export const LICENSE_PREFIX: Record<string, string> = {
  'en': 'Licensed under',
  'zh-CN': '授权协议：',
  'zh-SG': '授权协议：',
  'zh-TW': '授權條款：',
  'zh-HK': '授權條款：',
  'es': 'Licenciado bajo',
  'hi': 'लाइसेंस:',
  'ar': 'مرخّص بموجب',
  'fr': 'Licence :',
  'pt': 'Licenciado sob',
  'de': 'Lizenziert unter',
  'ru': 'Лицензия:',
  'ja': 'ライセンス：',
  'ko': '라이선스:',
  'it': 'Licenza:',
  'nl': 'Gelicentieerd onder',
  'pl': 'Licencja:',
  'tr': 'Lisans:',
  'sv': 'Licensierad under',
  'da': 'Licenseret under',
  'fi': 'Lisensoitu:',
  'nb': 'Lisensiert under',
  'no': 'Lisensiert under',
  'cs': 'Licence:',
  'ro': 'Licențiat sub',
  'hu': 'Licenc:',
  'el': 'Άδεια χρήσης:',
  'th': 'สัญญาอนุญาต:',
  'id': 'Dilisensikan di bawah',
  'ms': 'Dilesenkan di bawah',
  'uk': 'Ліцензія:',
  'vi': 'Giấy phép:',
  'he': 'מורשה תחת',
};

// --- Generic locale resolution ---
export function getLocalizedString(
  record: Record<string, string>,
  langs: string[],
): string {
  for (const lang of langs) {
    if (record[lang]) {
      return record[lang];
    }
    const base = lang.split('-')[0];
    if (record[base]) {
      return record[base];
    }
  }
  return record['en'];
}

// --- Public API (uses Electron app internally) ---

export function getLoadingText(): { text: string; lang: string } {
  const langs = app.getPreferredSystemLanguages();
  for (const lang of langs) {
    if (LOADING_TEXT[lang]) {
      i18nLog.debug(`resolved locale: ${lang} (exact)`);
      return { text: LOADING_TEXT[lang], lang };
    }
    const base = lang.split('-')[0];
    if (LOADING_TEXT[base]) {
      i18nLog.debug(`resolved locale: ${base} (from ${lang})`);
      return { text: LOADING_TEXT[base], lang: base };
    }
  }
  i18nLog.debug('resolved locale: en (fallback)');
  return { text: LOADING_TEXT['en'], lang: 'en' };
}

export function getTrayStrings(): { about: string; quit: string } {
  const langs = app.getPreferredSystemLanguages();
  const pkg = require(path.join(__dirname, '..', 'package.json'));
  const productName: string = pkg.build?.productName ?? app.getName();
  const aboutTemplate = getLocalizedString(ABOUT_TEXT, langs);
  const about = aboutTemplate.replace('{name}', productName);
  const quit = getLocalizedString(QUIT_TEXT, langs);
  return { about, quit };
}

export function getAboutStrings(): {
  close: string;
  versionPrefix: string;
  copyrightSuffix: string;
  licensePrefix: string;
} {
  const langs = app.getPreferredSystemLanguages();
  return {
    close: getLocalizedString(CLOSE_TEXT, langs),
    versionPrefix: getLocalizedString(VERSION_PREFIX, langs),
    copyrightSuffix: getLocalizedString(COPYRIGHT_SUFFIX, langs),
    licensePrefix: getLocalizedString(LICENSE_PREFIX, langs),
  };
}
