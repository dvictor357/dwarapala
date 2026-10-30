import { invalidateDigest, suggestReply, triageThread } from './ai.ts';
import { createDraft } from './approvals.ts';
import { audit } from './audit.ts';
import type { Channel } from './config.ts';
import { all, one, parseJson, run } from './db.ts';
import { getThread, updateThread } from './inbox.ts';
import type { InboundEvent } from './sync.ts';

/**
 * A slim automation engine: on every new inbound message, enabled rules whose
 * conditions match run their actions in order. There is deliberately no "send"
 * action: the strongest thing a rule can do is put a draft in the approval queue.
 */
export type RuleConditions = { channels?: Channel[]; accountIds?: number[]; anyKeywords?: string[] };
export type RuleAction =
  | { type: 'set_priority'; value: 'high' | 'normal' | 'low' }
  | { type: 'add_tag'; value: string }
  | { type: 'assign'; value: string }
  | { type: 'mark_done' }
  | { type: 'suggest_reply' };

export type Rule = { id: number; name: string; enabled: boolean; conditions: RuleConditions; actions: RuleAction[] };

type RawRule = { id: number; name: string; enabled: number; conditions: string; actions: string };

export const listRules = (): Rule[] =>
  all<RawRule>('SELECT * FROM rules ORDER BY id').map((r) => ({
    id: r.id,
    name: r.name,
    enabled: !!r.enabled,
    conditions: parseJson<RuleConditions>(r.conditions, {}),
    actions: parseJson<RuleAction[]>(r.actions, []),
  }));

export function setRuleEnabled(id: number, enabled: boolean, actor: string): void {
  run('UPDATE rules SET enabled = ? WHERE id = ?', enabled ? 1 : 0, id);
  const r = one<{ name: string }>('SELECT name FROM rules WHERE id = ?', id);
  if (r) audit(actor, 'rule.updated', `${enabled ? 'Enabled' : 'Disabled'} rule "${r.name}"`, { type: 'rule', id });
}

function matches(rule: Rule, channel: Channel, accountId: number, haystack: string): boolean {
  const c = rule.conditions;
  if (c.channels?.length && !c.channels.includes(channel)) return false;
  if (c.accountIds?.length && !c.accountIds.includes(accountId)) return false;
  if (c.anyKeywords?.length) {
    const h = haystack.toLowerCase();
    if (!c.anyKeywords.some((k) => h.includes(k.toLowerCase()))) return false;
  }
  return true;
}

export async function handleInbound(events: InboundEvent[]): Promise<void> {
  invalidateDigest();
  const rules = listRules().filter((r) => r.enabled);
  // One pass per thread even if several messages arrived in the same sync.
  for (const threadId of new Set(events.map((e) => e.threadId))) {
    await triageThread(threadId);
    const t = getThread(threadId);
    if (!t) continue;
    const latest = [...t.messages].reverse().find((m) => m.direction === 'in');
    const haystack = `${t.subject}\n${latest?.body ?? ''}`;

    for (const rule of rules) {
      if (!matches(rule, t.channel, t.account_id, haystack)) continue;
      const done: string[] = [];
      for (const action of rule.actions) {
        const fresh = getThread(threadId)!;
        switch (action.type) {
          case 'set_priority':
            updateThread(threadId, { priority: action.value });
            done.push(`priority → ${action.value}`);
            break;
          case 'add_tag':
            updateThread(threadId, { tags: [...fresh.tags, action.value] });
            done.push(`tag +${action.value}`);
            break;
          case 'assign':
            updateThread(threadId, { assignee: action.value });
            done.push(`assigned → ${action.value}`);
            break;
          case 'mark_done':
            updateThread(threadId, { status: 'done' });
            done.push('marked done');
            break;
          case 'suggest_reply': {
            if (fresh.pending_approvals > 0) break;
            const s = await suggestReply(threadId);
            if (!s.body) break;
            await createDraft({ threadId, body: s.body, requestedBy: `rule:${rule.name}`, queue: true });
            done.push('reply suggested → approval queue');
            break;
          }
        }
      }
      if (done.length) audit(`rule:${rule.name}`, 'rule.applied', `${t.subject}: ${done.join(', ')}`, { type: 'thread', id: threadId });
    }
  }
}
