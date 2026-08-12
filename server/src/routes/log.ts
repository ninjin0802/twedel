import { Router } from 'express';
import { z } from 'zod';
import type { LogFilter } from '../log.js';
import { readLog, toCsv } from '../log.js';
import { parseQuery } from './http.js';

export const logRouter = Router();

const querySchema = z.object({
  runId: z.string().optional(),
  q: z.string().optional(),
  // An empty `status` means "no filter": the UI's <select> submits "" for
  // "すべて", and rejecting that would break the default view.
  status: z.union([z.enum(['pending', 'deleted', 'already_gone', 'failed']), z.literal('')]).optional(),
});

function toFilter(q: z.infer<typeof querySchema>): LogFilter {
  return {
    ...(q.runId ? { runId: q.runId } : {}),
    ...(q.q ? { q: q.q } : {}),
    ...(q.status ? { status: q.status } : {}),
  };
}

logRouter.get('/log', async (req, res) => {
  const query = parseQuery(querySchema, req);
  const { entries } = await readLog(toFilter(query));
  res.json({ entries });
});

logRouter.get('/log.csv', async (req, res) => {
  const query = parseQuery(querySchema, req);
  const { entries } = await readLog(toFilter(query));
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="twedel-log-${stamp}.csv"`);
  // BOM: without it Excel opens a UTF-8 CSV as Shift_JIS and mangles every
  // non-ASCII tweet - which for this app's users is most of them.
  res.send(`\uFEFF${toCsv(entries)}`);
});
