import { Router, urlencoded } from 'express';
import { ApprovalError, approve, getApproval, reject } from './approvals.ts';
import { audit } from './audit.ts';
import { run } from './db.ts';
import { readLink } from './notify.ts';

/**
 * Approve / reject links from Telegram or email.
 * GET only renders a confirm page: chat apps and mail scanners prefetch URLs,
 * and a prefetch must never send a message. The POST does the work, and each
 * link's nonce is single-use.
 */
export const links = Router();

const esc = (s: string | null | undefined) =>
  (s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const page = (title: string, body: string) => `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
  body{font:15px/1.5 ui-sans-serif,system-ui,sans-serif;background:#f4f1ea;color:#1d1b16;margin:0;padding:24px}
  main{max-width:560px;margin:0 auto;background:#fff;border:1px solid #e3ddd0;border-radius:14px;padding:24px}
  h1{font-size:20px;margin:0 0 4px} .meta{color:#6b6457;font-size:13px;margin-bottom:16px}
  .box{white-space:pre-wrap;background:#faf8f3;border:1px solid #eee7d8;border-radius:10px;padding:12px;margin:6px 0 14px}
  label{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#6b6457}
  textarea{width:100%;box-sizing:border-box;min-height:140px;font:inherit;padding:10px;border-radius:10px;border:1px solid #d8d0bf}
  button{font:inherit;border:0;border-radius:999px;padding:10px 18px;cursor:pointer;margin-right:8px}
  .ok{background:#1f6f4a;color:#fff} .no{background:#efe9dc;color:#7a2e1e}
</style></head><body><main>${body}</main></body></html>`;

links.get('/a/:token', (req, res) => {
  const p = readLink(req.params.token);
  if (!p) return void res.status(400).send(page('Link invalid', '<h1>This link is invalid or expired.</h1>'));
  const a = getApproval(p.a);
  if (!a) return void res.status(404).send(page('Not found', '<h1>That draft no longer exists.</h1>'));
  if (a.status !== 'pending') {
    return void res.send(page('Already decided', `<h1>Already ${esc(a.status)}</h1><p class="meta">by ${esc(a.decided_by)} at ${esc(a.decided_at)}</p>`));
  }
  const approveMode = p.act === 'approve';
  res.send(
    page(
      approveMode ? 'Approve reply' : 'Reject reply',
      `<h1>${approveMode ? 'Approve and send this reply?' : 'Reject this draft?'}</h1>
       <div class="meta">${esc(a.account_label)} · to ${esc(a.recipient)} · requested by ${esc(a.requested_by)}</div>
       <label>They wrote</label><div class="box">${esc(a.original_body)}</div>
       <form method="post">
         ${approveMode
           ? `<label>Reply (you can edit)</label><textarea name="body">${esc(a.draft_body)}</textarea><p><button class="ok">Approve &amp; send</button></p>`
           : `<label>Draft</label><div class="box">${esc(a.draft_body)}</div><p><button class="no">Reject</button></p>`}
       </form>`,
    ),
  );
});

links.post('/a/:token', urlencoded({ extended: false }), async (req, res) => {
  const p = readLink(req.params.token);
  if (!p) return void res.status(400).send(page('Link invalid', '<h1>This link is invalid or expired.</h1>'));
  const used = run('INSERT OR IGNORE INTO used_links (nonce) VALUES (?)', p.n);
  if (!used.changes) {
    audit(`link:${p.c}`, 'link.rejected', 'Approval link reused', { type: 'approval', id: p.a });
    return void res.status(409).send(page('Link used', '<h1>This link was already used.</h1>'));
  }
  const actor = `link:${p.c}`;
  try {
    if (p.act === 'approve') {
      const body = typeof req.body?.body === 'string' ? req.body.body : undefined;
      const a = await approve(p.a, actor, body);
      return void res.send(
        page('Done', a.status === 'sent' ? '<h1>Sent ✓</h1><p>The reply was approved and sent.</p>' : `<h1>Send failed</h1><p>${esc(a.error)}</p>`),
      );
    }
    reject(p.a, actor);
    res.send(page('Rejected', '<h1>Rejected</h1><p>Nothing was sent.</p>'));
  } catch (err) {
    // A blocked send (kill switch, allowlist, rate limit) frees the link for another try.
    if (err instanceof ApprovalError && err.status === 423) run('DELETE FROM used_links WHERE nonce = ?', p.n);
    res.status(err instanceof ApprovalError ? err.status : 500).send(page('Not sent', `<h1>Not sent</h1><p>${esc((err as Error).message)}</p>`));
  }
});

