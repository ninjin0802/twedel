import { createContext, useCallback, useContext, useEffect, useRef, useState, type RefObject } from 'react';

export type Language = 'ja' | 'en';

const LANGUAGE_KEY = 'twedel.language';

const translations: Array<[string, string]> = [
  ['利用前に必ずご確認ください', 'Please read before using twedel'],
  ['非公式APIを使用しています', 'Uses an unofficial API'],
  ['twedelはX公式APIではなく、XのWebクライアント向け内部APIを利用します。Xの仕様変更で動作しなくなるほか、利用規約への抵触、機能制限、アカウント凍結などの可能性があります。利用はご自身の判断と責任で行ってください。', 'twedel uses an internal API intended for the X web client, not the official X API. Changes to X may stop it from working, and use may result in terms-of-service issues, feature restrictions, or account suspension. Use it at your own risk.'],
  ['削除したポストや取り消した「いいね」は元に戻せません。', 'Deleted posts and removed likes cannot be restored.'],
  ['Xによる制限・凍結・損失について、開発者は保証できません。', 'The developer cannot cover restrictions, suspensions, or losses imposed by X.'],
  ['認証CookieはこのWindowsユーザーのDPAPIで暗号化して端末内に保存します。', 'Authentication cookies are encrypted with this Windows user’s DPAPI and stored locally.'],
  ['上記の内容を理解し、自分の責任で利用します', 'I understand the above and use this app at my own risk'],
  ['同意して利用を開始', 'Agree and continue'],
  ['Xの利用に関する重要事項', 'Important information about using X'],
  ['ポストを取得して、安全に整理しましょう', 'Fetch and safely clean up your posts'],
  ['接続方法と高度なオプション', 'Connection methods and advanced options'],
  ['新機能と改善の履歴', 'New features and improvement history'],
  ['アプリ情報と更新の確認', 'App information and updates'],
  ['バックエンド (http://127.0.0.1:5174) に接続できません。', 'Cannot connect to the backend (http://127.0.0.1:5174). '],
  ['で起動してください。サンプルデータで画面の確認だけは行えます。', 'to start it. You can still preview the UI with sample data.'],
  ['保護したポストは選択・削除されません。固定ポストはライブ取得時に自動保護されます。', 'Protected posts cannot be selected or deleted. Pinned posts are protected automatically during live fetches.'],
  ['この操作は取り消せません。削除されたポストは X から復元できません。', 'This action cannot be undone. Deleted posts cannot be restored from X.'],
  ['日付の指定が正しくないため、対象を 0 件として扱っています', 'The date is invalid, so the result is being treated as 0 items'],
  ['条件に一致するポストがありません。', 'No posts match these filters.'],
  ['Xへの接続が完了すると取得できます。', 'You can fetch data after connecting to X.'],
  ['Xへの接続が完了すると削除できます', 'You can delete after connecting to X'],
  ['自分のポストといいねを一度に読み込みます', 'Load your posts and likes together'],
  ['Xから自分のポストを取得したあと、いいねした投稿も続けて取得します。取得件数はそれぞれに適用されます。', 'After fetching your posts from X, twedel also fetches posts you liked. The item limit applies to each source.'],
  ['この実行はもう見つかりません（サーバーが再起動された可能性があります）。', 'This run could not be found (the server may have restarted).'],
  ['X のレート制限に達したため待機しています。', 'Waiting because the X rate limit was reached.'],
  ['中断された削除があります', 'An interrupted deletion is available'],
  ['再開すると、中断した続きだけを削除します。', 'Resuming deletes only the remaining items.'],
  ['現在のバージョン', 'Current version'],
  ['アップデートを確認しています', 'Checking for updates'],
  ['更新パッケージをダウンロード中', 'Downloading update'],
  ['削除処理が終了してから更新できます。', 'You can update after deletion finishes.'],
  ['ブラウザ版では更新機能を利用できません。', 'Updates are unavailable in the browser version.'],
  ['自分のX投稿を取得・絞り込み・一括削除する、Windows向けローカルアプリです。', 'A local Windows app for fetching, filtering, and bulk-deleting your X posts.'],
  ['日本語・英語の表示切り替え', 'Japanese and English interface'],
  ['アプリ画面を日本語と英語で切り替え可能に変更', 'Added Japanese/English interface switching'],
  ['OS・ブラウザの言語から初回表示を自動選択', 'Select the initial language from the OS or browser language'],
  ['選択した言語を端末内に保存', 'Save the selected language locally'],
  ['READMEとリリースノートを日本語・英語の両方で提供', 'Provide the README and release notes in Japanese and English'],
  ['削除した投稿の履歴ログは保存しません', 'Deletion history is not retained'],
  ['支援の有無による機能差はありません', 'Support does not change available features'],
  ['メニューを閉じる', 'Close menu'], ['メニューを開く', 'Open menu'], ['メインメニュー', 'Main menu'],
  ['表示中のすべてを選択', 'Select all visible'], ['表示中をすべて選択', 'Select all visible'],
  ['削除までの手順', 'Deletion workflow'], ['対象の選択', 'Select items'], ['選択を解除', 'Clear selection'],
  ['削除を確認', 'Review deletion'], ['最終確認 (ドライラン)', 'Final review (dry run)'],
  ['まとめて取得中', 'Fetching all'], ['ポストといいねを取得', 'Fetch posts and likes'], ['まとめて取得', 'Fetch all'],
  ['その他の取得方法（アーカイブZIP）', 'Other source (archive ZIP)'], ['サンプルデータを読み込む', 'Load sample data'],
  ['アーカイブのパス (絶対パス)', 'Archive path (absolute)'], ['取得件数 (任意)', 'Item limit (optional)'],
  ['未指定なら全件', 'All items if blank'], ['未指定', 'Any'], ['読み込み中', 'Loading'], ['読み込み', 'Load'],
  ['開始日 (含む)', 'Start date (inclusive)'], ['終了日 (含む)', 'End date (inclusive)'],
  ['大文字小文字を区別しません', 'Case-insensitive'], ['キーワード条件', 'Keyword rule'],
  ['いいね数 上限', 'Max likes'], ['RT数 上限', 'Max reposts'], ['メディア付きも含める', 'Include posts with media'],
  ['表示テーマ', 'Display theme'], ['詳細設定', 'Settings'], ['アップデート内容', 'What’s new'], ['バージョン情報', 'About'],
  ['システム', 'System'], ['ライト', 'Light'], ['ダーク', 'Dark'], ['テーマ', 'Theme'], ['言語', 'Language'],
  ['ホーム', 'Home'], ['接続', 'Connect'], ['取得', 'Fetch'], ['絞り込み', 'Filter'], ['選択・削除', 'Select & delete'],
  ['キーワード', 'Keyword'], ['含まない', 'Exclude'], ['含む', 'Include'],
  ['通常ポスト', 'Post'], ['ポスト', 'Post'], ['返信', 'Reply'], ['リポスト', 'Repost'], ['いいね', 'Like'],
  ['メディア', 'Media'], ['日付', 'Date'], ['種別', 'Type'], ['本文', 'Text'], ['保護', 'Protect'],
  ['実行状況', 'Progress'], ['実行中', 'Running'], ['レート制限で待機中', 'Waiting for rate limit'],
  ['中断処理中', 'Stopping'], ['中断しました', 'Stopped'], ['中断しています', 'Stopping'], ['中断', 'Stop'],
  ['見つかりません', 'Not found'], ['準備中', 'Preparing'], ['処理中', 'Processing'], ['処理待ち', 'Pending'],
  ['既に削除済み', 'Already deleted'], ['削除済み', 'Deleted'], ['成功', 'Succeeded'], ['失敗', 'Failed'],
  ['完了', 'Done'], ['エラー', 'Error'], ['経過', 'Elapsed'], ['残り (ETA)', 'Remaining (ETA)'],
  ['再開できます', 'Can resume'], ['再開しています', 'Resuming'], ['再開', 'Resume'], ['破棄', 'Discard'],
  ['確認する', 'View'], ['更新を確認', 'Check for updates'], ['ダウンロードして自動更新', 'Download and update'],
  ['再起動して更新', 'Restart and update'], ['更新内容', 'Release notes'], ['最新版です。', 'You are up to date.'],
  ['キャンセル', 'Cancel'], ['閉じる', 'Close'], ['開始中', 'Starting'], ['すべて', 'All'], ['状態', 'Status'],
  ['再読み込み', 'Reload'], ['日時', 'Time'], ['投稿日', 'Posted'], ['本文 / エラー', 'Text / error'],
  ['削除ログ', 'Deletion log'], ['本文検索', 'Search text'], ['CSV エクスポート', 'Export CSV'],
  ['件を選択中', ' selected'], ['件中', ' of '], ['件', ' items'], ['合計', 'Total'], ['内訳', 'Breakdown'], ['期間', 'Date range'],
];

function translate(value: string): string {
  let result = value;
  for (const [ja, en] of translations) result = result.replaceAll(ja, en);
  return result;
}

interface LanguageValue { language: Language; setLanguage: (language: Language) => void }
const LanguageContext = createContext<LanguageValue>({ language: 'ja', setLanguage: () => undefined });

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [language, setLanguageState] = useState<Language>(() => {
    try {
      const saved = localStorage.getItem(LANGUAGE_KEY);
      if (saved === 'ja' || saved === 'en') return saved;
    } catch {}
    return typeof navigator !== 'undefined' && !navigator.language.toLowerCase().startsWith('ja') ? 'en' : 'ja';
  });
  const setLanguage = useCallback((next: Language) => {
    setLanguageState(next);
    try { localStorage.setItem(LANGUAGE_KEY, next); } catch {}
  }, []);
  useEffect(() => { document.documentElement.lang = language; }, [language]);
  return <LanguageContext.Provider value={{ language, setLanguage }}>{children}</LanguageContext.Provider>;
}

export function useLanguage() { return useContext(LanguageContext); }

const originalText = new WeakMap<Text, string>();
const appliedText = new WeakMap<Text, string>();
const originalAttrs = new WeakMap<Element, Map<string, string>>();
const localizedAttrs = ['aria-label', 'title', 'placeholder'];

export function useLocalizedRoot(language: Language): RefObject<HTMLDivElement | null> {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const localize = () => {
      if (!root.current) return;
      const walker = document.createTreeWalker(root.current, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      while ((node = walker.nextNode())) {
        const textNode = node as Text;
        const current = textNode.data;
        if (!originalText.has(textNode) || (appliedText.has(textNode) && current !== appliedText.get(textNode))) originalText.set(textNode, current);
        const next = language === 'en' ? translate(originalText.get(textNode) ?? current) : (originalText.get(textNode) ?? current);
        if (current !== next) textNode.data = next;
        appliedText.set(textNode, next);
      }
      for (const element of root.current.querySelectorAll('*')) {
        let originals = originalAttrs.get(element);
        if (!originals) { originals = new Map(); originalAttrs.set(element, originals); }
        for (const attr of localizedAttrs) {
          const current = element.getAttribute(attr);
          if (current === null) continue;
          if (!originals.has(attr)) originals.set(attr, current);
          const source = originals.get(attr) ?? current;
          const next = language === 'en' ? translate(source) : source;
          if (next !== current) element.setAttribute(attr, next);
        }
      }
    };
    localize();
    const observer = new MutationObserver(localize);
    if (root.current) observer.observe(root.current, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: localizedAttrs });
    return () => observer.disconnect();
  }, [language]);
  return root;
}
