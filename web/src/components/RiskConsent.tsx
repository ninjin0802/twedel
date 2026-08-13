import { useState } from 'react';

export const RISK_CONSENT_KEY = 'twedel.riskConsent.v1';

export function RiskNotice() {
  return <aside className="risk-notice" role="note" aria-label="Xの利用に関する重要事項">
    <strong>非公式APIを使用しています</strong>
    <p>twedelはX公式APIではなく、XのWebクライアント向け内部APIを利用します。Xの仕様変更で動作しなくなるほか、利用規約への抵触、機能制限、アカウント凍結などの可能性があります。利用はご自身の判断と責任で行ってください。</p>
  </aside>;
}

export function RiskConsent({ onAccept }: { onAccept: () => void }) {
  const [confirmed, setConfirmed] = useState(false);
  return <div className="consent-backdrop" role="presentation">
    <section className="consent-dialog" role="dialog" aria-modal="true" aria-labelledby="risk-consent-title">
      <span className="consent-dialog__icon" aria-hidden="true">!</span>
      <h1 id="risk-consent-title">利用前に必ずご確認ください</h1>
      <RiskNotice />
      <ul>
        <li>削除したポストや取り消した「いいね」は元に戻せません。</li>
        <li>Xによる制限・凍結・損失について、開発者は保証できません。</li>
        <li>認証CookieはこのWindowsユーザーのDPAPIで暗号化して端末内に保存します。</li>
      </ul>
      <label className="consent-check"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />上記の内容を理解し、自分の責任で利用します</label>
      <button type="button" className="btn btn--primary" disabled={!confirmed} onClick={onAccept}>同意して利用を開始</button>
    </section>
  </div>;
}
