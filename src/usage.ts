import { execFile } from 'child_process';
import * as fsp from 'fs/promises';
import * as path from 'path';

export interface UsageLimit {
  key: string;
  label: string;
  percent: number;
  severity: string;
  resetsAt?: number;
  isActive: boolean;
  usedDollars?: number;
  limitDollars?: number;
}

export interface UsageSnapshot {
  limits: UsageLimit[];
  fetchedAt: number;
  error?: string;
}

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage?skip_spend=1';

export async function fetchUsage(claudeDir: string, version: string): Promise<UsageSnapshot> {
  const fetchedAt = Date.now();
  const token = await readAccessToken(claudeDir);
  if (!token) return { limits: [], fetchedAt, error: 'No Claude login found (run `claude` and sign in)' };
  try {
    const res = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        Accept: 'application/json',
        'User-Agent': `claude-code/${version}`,
      },
    });
    if (!res.ok) {
      const hint = res.status === 401 ? 'token expired; it refreshes next time Claude Code runs' : `HTTP ${res.status}`;
      return { limits: [], fetchedAt, error: `Usage unavailable (${hint})` };
    }
    return { limits: parseLimits(await res.json()), fetchedAt };
  } catch (err: any) {
    return { limits: [], fetchedAt, error: `Usage unavailable (${err?.message ?? String(err)})` };
  }
}

function parseLimits(body: any): UsageLimit[] {
  const out: UsageLimit[] = [];
  if (Array.isArray(body?.limits) && body.limits.length) {
    for (const l of body.limits) {
      if (typeof l?.percent !== 'number') continue;
      out.push({
        key: `${l.kind}:${l.scope?.model?.display_name ?? l.scope?.surface ?? ''}`,
        label: limitLabel(l),
        percent: l.percent,
        severity: typeof l.severity === 'string' ? l.severity : 'normal',
        resetsAt: parseDate(l.resets_at),
        isActive: Boolean(l.is_active),
      });
    }
  }
  if (!out.length) {
    for (const [key, label] of [
      ['five_hour', '5h'],
      ['seven_day', '7d'],
    ] as const) {
      const w = body?.[key];
      if (typeof w?.utilization !== 'number') continue;
      out.push({ key, label, percent: w.utilization, severity: 'normal', resetsAt: parseDate(w.resets_at), isActive: false });
    }
  }
  for (const l of out) {
    const raw = l.key.startsWith('session') ? body?.five_hour : l.key.startsWith('weekly_all') ? body?.seven_day : undefined;
    if (typeof raw?.used_dollars === 'number') l.usedDollars = raw.used_dollars;
    if (typeof raw?.limit_dollars === 'number') l.limitDollars = raw.limit_dollars;
  }
  return out;
}

function limitLabel(l: any): string {
  switch (l.kind) {
    case 'session':
      return '5h';
    case 'weekly_all':
      return '7d';
    case 'weekly_scoped':
      return l.scope?.model?.display_name ?? l.scope?.surface ?? '7d scoped';
    default:
      return String(l.kind ?? 'limit');
  }
}

function parseDate(v: unknown): number | undefined {
  if (typeof v !== 'string') return undefined;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : t;
}

async function readAccessToken(claudeDir: string): Promise<string | undefined> {
  const fromKeychain = process.platform === 'darwin' ? await keychainCredentials() : undefined;
  const raw = fromKeychain ?? (await fileCredentials(claudeDir));
  if (!raw) return undefined;
  try {
    const token = JSON.parse(raw)?.claudeAiOauth?.accessToken;
    return typeof token === 'string' && token ? token : undefined;
  } catch {
    return undefined;
  }
}

function keychainCredentials(): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { maxBuffer: 1 << 20 }, (err, stdout) => {
      resolve(err ? undefined : stdout.trim());
    });
  });
}

async function fileCredentials(claudeDir: string): Promise<string | undefined> {
  try {
    return await fsp.readFile(path.join(claudeDir, '.credentials.json'), 'utf8');
  } catch {
    return undefined;
  }
}

export function usageSummary(usage: UsageSnapshot | undefined): string {
  if (!usage) return "loading…";
  if (usage.error) return usage.error;
  return usage.limits.map((l) => `${l.label} ${Math.round(l.percent)}%`).join(" · ");
}
