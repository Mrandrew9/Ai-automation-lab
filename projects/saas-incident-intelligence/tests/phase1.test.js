// Replays a full incident lifecycle through the workflow's Code nodes, using
// synthetic vendor feeds in tests/fixtures. The JavaScript is read straight from
// workflow/phase1-detection.json, so tests always match what you import into n8n.
// Run: node --test projects/saas-incident-intelligence/tests/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const wf = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'workflow', 'phase1-detection.json'), 'utf8'));
const code = (name) => wf.nodes.find((n) => n.name === name).parameters.jsCode;
const fixture = (f) => fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8');

const NOW = Date.parse('2026-11-10T00:00:00Z');
const HOUR = 60 * 60 * 1000;

// Runs a Code node body with n8n's globals mocked and a fixed clock.
function run(body, { input = [], refs = {}, state = {}, now = NOW } = {}) {
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const $input = { all: () => input.map((json) => ({ json })), first: () => ({ json: input[0] }) };
  const $ = (name) => ({ all: () => (refs[name] || []).map((json) => ({ json })) });
  const fn = new Function('$input', '$', '$getWorkflowStaticData', 'Date', body);
  return fn($input, $, () => state, FixedDate).map((i) => i.json);
}

const registry = run(code('Load Application Registry'));
const byVendor = (events, id) => events.filter((e) => e.vendor_id === id);
const poll = (state, { slack, okta, google }, now = NOW) =>
  run(code('Normalize & Deduplicate'), {
    input: [slack, okta, google],
    refs: { 'Load Application Registry': registry },
    state,
    now,
  });
const ok = (data) => ({ data });
const fail = (message) => ({ error: { message } });
const feeds = {
  slack: ok(fixture('slack-current-active.json')),
  okta: ok(fixture('okta-feed.xml')),
  google: ok(fixture('google-incidents.json')),
};

test('registry returns only enabled pilot vendors, in order', () => {
  assert.deepStrictEqual(registry.map((r) => r.vendor_id), ['slack', 'okta', 'google_workspace']);
});

test('first poll alerts on active incidents and ignores history', () => {
  const events = poll({}, feeds);
  assert.strictEqual(events.length, 3);
  const [slack] = byVendor(events, 'slack');
  assert.strictEqual(slack.change_type, 'new');
  assert.strictEqual(slack.vendor_impact, 'major');
  assert.strictEqual(slack.notify_owners, true);
  const [okta] = byVendor(events, 'okta');
  assert.strictEqual(okta.vendor_incident_id, 'EXAMPLE00000001AAA');
  assert.strictEqual(okta.notify_owners, true);
  const [google] = byVendor(events, 'google_workspace');
  assert.strictEqual(google.vendor_impact, 'minor');
  assert.strictEqual(google.notify_owners, false, 'minor impact is informational: channel only');
  assert.strictEqual(google.source_url, 'https://www.google.com/appsstatus/dashboard/incidents/exampleGws001');
});

test('repeat polls with no change send nothing', () => {
  const state = {};
  poll(state, feeds);
  assert.deepStrictEqual(poll(state, feeds), []);
  assert.deepStrictEqual(poll(state, feeds), []);
});

test('vendor resolution asks owners to verify recovery', () => {
  const state = {};
  poll(state, feeds);
  const resolved = fixture('okta-feed.xml').replace('<title>Service Disruption</title>', '<title>Resolved Service Disruption</title>');
  const events = poll(state, { ...feeds, okta: ok(resolved) });
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].change_type, 'vendor_resolved');
  assert.strictEqual(events[0].notify_owners, true);
  assert.match(events[0].dm_text, /confirm our users have recovered/);
});

test('an incident that disappears is flagged, never auto-resolved', () => {
  const state = {};
  poll(state, feeds);
  const events = poll(state, { ...feeds, slack: ok(fixture('slack-current-ok.json')) });
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].change_type, 'no_longer_listed');
  assert.strictEqual(events[0].vendor_status, 'no_longer_listed');
  assert.deepStrictEqual(poll(state, { ...feeds, slack: ok(fixture('slack-current-ok.json')) }), [], 'flagged once only');
});

test('feed failures alert after 2 in a row, then at most hourly', () => {
  const state = {};
  const broken = { ...feeds, okta: fail('ETIMEDOUT') };
  assert.strictEqual(byVendor(poll(state, broken), 'okta').length, 0, 'one failure is tolerated');
  const second = byVendor(poll(state, broken, NOW + 15 * 60000), 'okta');
  assert.strictEqual(second.length, 1);
  assert.strictEqual(second[0].event_type, 'feed_error');
  assert.match(second[0].channel_text, /2 consecutive polls failed/);
  assert.strictEqual(byVendor(poll(state, broken, NOW + 30 * 60000), 'okta').length, 0, 'cooldown');
  assert.strictEqual(byVendor(poll(state, broken, NOW + 2 * HOUR), 'okta').length, 1, 'cooldown expired');
});

test('malformed feed counts as a failure, not a crash', () => {
  const state = {};
  poll(state, { ...feeds, google: ok('<html>maintenance page</html>') });
  const events = poll(state, { ...feeds, google: ok('not json') }, NOW + 15 * 60000);
  assert.strictEqual(byVendor(events, 'google_workspace')[0].event_type, 'feed_error');
});

test('vendor text is sanitized before it reaches Slack', () => {
  const [slack] = byVendor(poll({}, feeds), 'slack');
  assert.ok(!slack.channel_text.includes('<!channel>'), 'injected mention removed');
  assert.match(slack.channel_text, /\*Some users can't send messages\*/);
  assert.match(slack.channel_text, /Latest vendor note: We're investigating &amp; will update shortly\./);
  assert.ok(!/<p>/.test(slack.channel_text), 'HTML stripped');
});

test('HTML-encoded mentions and link markup are neutralized too', () => {
  const sneaky = fixture('slack-current-active.json').replace(
    "Some users can't send messages <!channel>",
    'Outage &lt;!here&gt; see <https://evil.example.com|status>',
  );
  const [slack] = byVendor(poll({}, { ...feeds, slack: ok(sneaky) }), 'slack');
  assert.ok(!slack.channel_text.includes('<!here>'));
  assert.ok(!slack.channel_text.includes('evil.example.com'));
});

test('links to hosts other than the vendor status page are replaced', () => {
  const atlassian = { vendor_id: 'atlassian', application_name: 'Jira', business_criticality: 'high', source_type: 'statuspage',
    status_page_url: 'https://status.atlassian.com/', primary_slack_user_id: 'U1', secondary_slack_user_id: 'U2' };
  const [event] = run(code('Normalize & Deduplicate'), {
    input: [ok(fixture('statuspage-incidents.json'))],
    refs: { 'Load Application Registry': [atlassian] },
  });
  assert.strictEqual(event.source_url, 'https://status.atlassian.com/');
  assert.ok(!event.channel_text.includes('evil.example.com'));
});

test('closed incidents are pruned after 30 days', () => {
  const state = {};
  poll(state, feeds);
  poll(state, { ...feeds, slack: ok(fixture('slack-current-ok.json')) });
  assert.ok(state.incidents['slack:9001']);
  poll(state, { ...feeds, slack: ok(fixture('slack-current-ok.json')) }, NOW + 31 * 24 * HOUR);
  assert.strictEqual(state.incidents['slack:9001'], undefined);
});

test('owner DMs go to each owner once, only for events that need action', () => {
  const events = poll({}, feeds);
  events.push({ ...events[0], primary_slack_user_id: 'USAME', secondary_slack_user_id: 'USAME' });
  const dms = run(code('Fan Out to Owners'), { input: events });
  assert.deepStrictEqual(dms.map((d) => d.slack_user_id), ['U00000SLACK1', 'U00000SLACK2', 'U00000OKTA01', 'U00000OKTA02', 'USAME']);
});
