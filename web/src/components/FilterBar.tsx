import type { FilterCriteria } from '@shared/types';
import type { CriteriaError } from '../filter';

interface Props {
  criteria: FilterCriteria;
  onChange: (criteria: FilterCriteria) => void;
  /** false when any loaded tweet came from an archive export */
  countsReliable: boolean;
  /** from `validateCriteria`; while non-empty the filter matches nothing and deletion is blocked */
  errors?: readonly CriteriaError[];
}

function numOrNull(value: string): number | null {
  if (value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function FilterBar({ criteria, onChange, countsReliable, errors = [] }: Props) {
  const patch = (next: Partial<FilterCriteria>) => onChange({ ...criteria, ...next });
  const errorFor = (field: CriteriaError['field']): string | undefined =>
    errors.find((e) => e.field === field)?.message;
  const fromError = errorFor('from');
  const toError = errorFor('to');

  return (
    <section className="panel">
      <header className="panel__head">
        <h2>
          <span className="step-badge">3</span> 絞り込み
        </h2>
      </header>

      <div className="grid grid--4">
        <label className={`field${fromError ? ' field--invalid' : ''}`}>
          <span className="field__label">開始日 (含む)</span>
          <input
            type="date"
            value={criteria.from ?? ''}
            aria-invalid={fromError !== undefined}
            onChange={(e) => patch({ from: e.target.value || undefined })}
          />
          {fromError && (
            <span className="field__error" role="alert">
              {fromError}
            </span>
          )}
        </label>
        <label className={`field${toError ? ' field--invalid' : ''}`}>
          <span className="field__label">終了日 (含む)</span>
          <input
            type="date"
            value={criteria.to ?? ''}
            aria-invalid={toError !== undefined}
            onChange={(e) => patch({ to: e.target.value || undefined })}
          />
          {toError && (
            <span className="field__error" role="alert">
              {toError}
            </span>
          )}
        </label>
        <label className="field">
          <span className="field__label">キーワード</span>
          <input
            type="text"
            value={criteria.keyword ?? ''}
            onChange={(e) => patch({ keyword: e.target.value || undefined })}
            placeholder="大文字小文字を区別しません"
          />
        </label>
        <label className="field">
          <span className="field__label">キーワード条件</span>
          <select
            value={criteria.keywordMode}
            onChange={(e) => patch({ keywordMode: e.target.value as FilterCriteria['keywordMode'] })}
          >
            <option value="include">含む</option>
            <option value="exclude">含まない</option>
          </select>
        </label>

        <label className={`field${countsReliable ? '' : ' field--disabled'}`}>
          <span className="field__label">いいね数 上限</span>
          <input
            type="number"
            min={0}
            disabled={!countsReliable}
            value={criteria.maxLikes ?? ''}
            onChange={(e) => patch({ maxLikes: numOrNull(e.target.value) })}
            placeholder="未指定"
          />
        </label>
        <label className={`field${countsReliable ? '' : ' field--disabled'}`}>
          <span className="field__label">RT数 上限</span>
          <input
            type="number"
            min={0}
            disabled={!countsReliable}
            value={criteria.maxRetweets ?? ''}
            onChange={(e) => patch({ maxRetweets: numOrNull(e.target.value) })}
            placeholder="未指定"
          />
        </label>
      </div>

      {errors.length > 0 && (
        <p className="inline-msg inline-msg--error" role="alert">
          日付の指定が正しくないため、対象を 0 件として扱っています (誤って全件を対象にしないための
          安全側の動作です)。日付を直すまで削除は実行できません。
        </p>
      )}

      {!countsReliable && (
        <p className="inline-msg inline-msg--warn" role="note">
          いいね／RT 数での絞り込みは使えません。X のアーカイブは実際の数に関係なく
          <code>"0"</code> / <code>"0.0"</code> を記録するため、これで絞り込むと意図しないツイートを
          削除してしまいます。件数で絞りたい場合は「ライブ取得」を使ってください。
        </p>
      )}

      <div className="checks">
        <label className="check">
          <input
            type="checkbox"
            checked={criteria.includeOriginals}
            onChange={(e) => patch({ includeOriginals: e.target.checked })}
          />
          原文
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={criteria.includeReplies}
            onChange={(e) => patch({ includeReplies: e.target.checked })}
          />
          リプライ
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={criteria.includeRetweets}
            onChange={(e) => patch({ includeRetweets: e.target.checked })}
          />
          リツイート
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={criteria.includeMediaTweets}
            onChange={(e) => patch({ includeMediaTweets: e.target.checked })}
          />
          メディア付きも含める
        </label>
      </div>
    </section>
  );
}
