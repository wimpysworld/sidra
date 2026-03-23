import { app } from 'electron';
import path from 'path';
import log from 'electron-log/main';

const i18nLog = log.scope('i18n');
const pkg = require(path.join(__dirname, '..', 'package.json'));

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

// --- "Notifications" ---
export const NOTIFICATIONS_TEXT: Record<string, string> = {
  'en': 'Notifications',
  'zh-CN': '通知',
  'zh-SG': '通知',
  'zh-TW': '通知',
  'zh-HK': '通知',
  'es': 'Notificaciones',
  'hi': 'सूचनाएँ',
  'ar': 'الإشعارات',
  'fr': 'Notifications',
  'pt': 'Notificações',
  'de': 'Benachrichtigungen',
  'ru': 'Уведомления',
  'ja': '通知',
  'ko': '알림',
  'it': 'Notifiche',
  'nl': 'Meldingen',
  'pl': 'Powiadomienia',
  'tr': 'Bildirimler',
  'sv': 'Aviseringar',
  'da': 'Notifikationer',
  'fi': 'Ilmoitukset',
  'nb': 'Varsler',
  'no': 'Varsler',
  'cs': 'Oznámení',
  'ro': 'Notificări',
  'hu': 'Értesítések',
  'el': 'Ειδοποιήσεις',
  'th': 'การแจ้งเตือน',
  'id': 'Notifikasi',
  'ms': 'Pemberitahuan',
  'uk': 'Сповіщення',
  'vi': 'Thông báo',
  'he': 'התראות',
};

// --- "Discord Rich Presence" ---
export const DISCORD_TEXT: Record<string, string> = {
  'en': 'Discord Rich Presence',
  'zh-CN': 'Discord 动态状态',
  'zh-SG': 'Discord 动态状态',
  'zh-TW': 'Discord 動態狀態',
  'zh-HK': 'Discord 動態狀態',
  'es': 'Presencia enriquecida de Discord',
  'hi': 'Discord रिच प्रेज़ेंस',
  'ar': 'حالة Discord التفصيلية',
  'fr': 'Présence enrichie Discord',
  'pt': 'Presença avançada do Discord',
  'de': 'Discord Rich Presence',
  'ru': 'Статус Discord',
  'ja': 'Discord Rich Presence',
  'ko': 'Discord Rich Presence',
  'it': 'Presenza avanzata Discord',
  'nl': 'Discord Rich Presence',
  'pl': 'Discord Rich Presence',
  'tr': 'Discord Zengin Durum',
  'sv': 'Discord Rich Presence',
  'da': 'Discord Rich Presence',
  'fi': 'Discord Rich Presence',
  'nb': 'Discord Rich Presence',
  'no': 'Discord Rich Presence',
  'cs': 'Discord Rich Presence',
  'ro': 'Prezență avansată Discord',
  'hu': 'Discord Rich Presence',
  'el': 'Discord Rich Presence',
  'th': 'Discord Rich Presence',
  'id': 'Discord Rich Presence',
  'ms': 'Discord Rich Presence',
  'uk': 'Статус Discord',
  'vi': 'Discord Rich Presence',
  'he': 'Discord Rich Presence',
};

// --- "Catppuccin" ---
export const CATPPUCCIN_TEXT: Record<string, string> = {
  'en': 'Catppuccin',
  'zh-CN': 'Catppuccin',
  'zh-SG': 'Catppuccin',
  'zh-TW': 'Catppuccin',
  'zh-HK': 'Catppuccin',
  'es': 'Catppuccin',
  'hi': 'Catppuccin',
  'ar': 'Catppuccin',
  'fr': 'Catppuccin',
  'pt': 'Catppuccin',
  'de': 'Catppuccin',
  'ru': 'Catppuccin',
  'ja': 'Catppuccin',
  'ko': 'Catppuccin',
  'it': 'Catppuccin',
  'nl': 'Catppuccin',
  'pl': 'Catppuccin',
  'tr': 'Catppuccin',
  'sv': 'Catppuccin',
  'da': 'Catppuccin',
  'fi': 'Catppuccin',
  'nb': 'Catppuccin',
  'no': 'Catppuccin',
  'cs': 'Catppuccin',
  'ro': 'Catppuccin',
  'hu': 'Catppuccin',
  'el': 'Catppuccin',
  'th': 'Catppuccin',
  'id': 'Catppuccin',
  'ms': 'Catppuccin',
  'uk': 'Catppuccin',
  'vi': 'Catppuccin',
  'he': 'Catppuccin',
};

// --- "Update available" ---
export const UPDATE_AVAILABLE_TEXT: Record<string, string> = {
  'en': 'Update available: {version}',
  'zh-CN': '有可用更新：{version}',
  'zh-SG': '有可用更新：{version}',
  'zh-TW': '有可用更新：{version}',
  'zh-HK': '有可用更新：{version}',
  'es': 'Actualización disponible: {version}',
  'hi': 'अपडेट उपलब्ध: {version}',
  'ar': 'تحديث متوفر: {version}',
  'fr': 'Mise à jour disponible : {version}',
  'pt': 'Atualização disponível: {version}',
  'de': 'Update verfügbar: {version}',
  'ru': 'Доступно обновление: {version}',
  'ja': 'アップデートあり: {version}',
  'ko': '업데이트 가능: {version}',
  'it': 'Aggiornamento disponibile: {version}',
  'nl': 'Update beschikbaar: {version}',
  'pl': 'Dostępna aktualizacja: {version}',
  'tr': 'Güncelleme mevcut: {version}',
  'sv': 'Uppdatering tillgänglig: {version}',
  'da': 'Opdatering tilgængelig: {version}',
  'fi': 'Päivitys saatavilla: {version}',
  'nb': 'Oppdatering tilgjengelig: {version}',
  'no': 'Oppdatering tilgjengelig: {version}',
  'cs': 'Dostupná aktualizace: {version}',
  'ro': 'Actualizare disponibilă: {version}',
  'hu': 'Frissítés elérhető: {version}',
  'el': 'Διαθέσιμη ενημέρωση: {version}',
  'th': 'มีอัปเดต: {version}',
  'id': 'Pembaruan tersedia: {version}',
  'ms': 'Kemas kini tersedia: {version}',
  'uk': 'Доступне оновлення: {version}',
  'vi': 'Có bản cập nhật: {version}',
  'he': 'עדכון זמין: {version}',
};

// --- "Up to date" ---
export const UP_TO_DATE_TEXT: Record<string, string> = {
  'en': 'Up to date',
  'zh-CN': '已是最新版本',
  'zh-SG': '已是最新版本',
  'zh-TW': '已是最新版本',
  'zh-HK': '已是最新版本',
  'es': 'Actualizado',
  'hi': 'अद्यतित',
  'ar': 'محدّث',
  'fr': 'À jour',
  'pt': 'Atualizado',
  'de': 'Aktuell',
  'ru': 'Обновлено',
  'ja': '最新版です',
  'ko': '최신 버전',
  'it': 'Aggiornato',
  'nl': 'Up-to-date',
  'pl': 'Aktualny',
  'tr': 'Güncel',
  'sv': 'Uppdaterad',
  'da': 'Opdateret',
  'fi': 'Ajan tasalla',
  'nb': 'Oppdatert',
  'no': 'Oppdatert',
  'cs': 'Aktuální',
  'ro': 'La zi',
  'hu': 'Naprakész',
  'el': 'Ενημερωμένο',
  'th': 'เป็นเวอร์ชันล่าสุด',
  'id': 'Terbaru',
  'ms': 'Terkini',
  'uk': 'Оновлено',
  'vi': 'Đã cập nhật',
  'he': 'מעודכן',
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

// --- Cached system language list ---
let _cachedLangs: string[] | null = null;
function getSystemLanguages(): string[] {
  if (!_cachedLangs) _cachedLangs = app.getPreferredSystemLanguages();
  return _cachedLangs;
}

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

function getLocalizedEntry(
  record: Record<string, string>,
  langs: string[],
): { value: string; lang: string } {
  for (const lang of langs) {
    if (record[lang]) return { value: record[lang], lang };
    const base = lang.split('-')[0];
    if (record[base]) return { value: record[base], lang: base };
  }
  return { value: record['en'], lang: 'en' };
}

// --- Public API (uses Electron app internally) ---

export function getStorefront(): string {
  const code = app.getLocaleCountryCode().toLowerCase();
  if (code) {
    i18nLog.debug(`storefront detected from locale: ${code}`);
    return code;
  }
  i18nLog.debug('storefront fallback: us');
  return 'us';
}

export function getLoadingText(): { text: string; lang: string } {
  const langs = getSystemLanguages();
  const { value: text, lang } = getLocalizedEntry(LOADING_TEXT, langs);
  i18nLog.debug(`resolved locale: ${lang}`);
  return { text, lang };
}

export function getTrayStrings(): { about: string; quit: string; notifications: string; discord: string; catppuccin: string } {
  const langs = getSystemLanguages();
  const productName: string = pkg.build?.productName ?? app.getName();
  const aboutTemplate = getLocalizedString(ABOUT_TEXT, langs);
  const about = aboutTemplate.replace('{name}', productName);
  const quit = getLocalizedString(QUIT_TEXT, langs);
  const notifications = getLocalizedString(NOTIFICATIONS_TEXT, langs);
  const discord = getLocalizedString(DISCORD_TEXT, langs);
  const catppuccin = getLocalizedString(CATPPUCCIN_TEXT, langs);
  return { about, quit, notifications, discord, catppuccin };
}

export function getAboutStrings(): {
  close: string;
  versionPrefix: string;
  copyrightSuffix: string;
  licensePrefix: string;
} {
  const langs = getSystemLanguages();
  return {
    close: getLocalizedString(CLOSE_TEXT, langs),
    versionPrefix: getLocalizedString(VERSION_PREFIX, langs),
    copyrightSuffix: getLocalizedString(COPYRIGHT_SUFFIX, langs),
    licensePrefix: getLocalizedString(LICENSE_PREFIX, langs),
  };
}

export function getUpdateStrings(): {
  updateAvailable: string;
  upToDate: string;
} {
  const langs = getSystemLanguages();
  return {
    updateAvailable: getLocalizedString(UPDATE_AVAILABLE_TEXT, langs),
    upToDate: getLocalizedString(UP_TO_DATE_TEXT, langs),
  };
}
