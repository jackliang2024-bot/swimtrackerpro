/* ============================================================================
   AquaTrack  -  cloud.js
   ----------------------------------------------------------------------------
   EVERYTHING that talks to Supabase lives in this one file.

   IMPORTANT FOR BEGINNERS
   - Guest Mode does NOT need this file. If this file fails to load, or Supabase
     is down, or you are offline, AquaTrack still works fully as a guest.
   - Only the "publishable" key is used here. It is designed to be public.
     Your data is protected by the database rules (Row Level Security), NOT by
     hiding this key. Never put a "secret" or "service_role" key in this file.
   - index.html shares data with this file through a small object called AQ.

   MAP OF THIS FILE
     1. Settings
     2. Small helpers
     3. Pending-changes queue (so nothing is lost when offline)
     4. Talking to the database (swims, settings, public results)
     5. Sync (pull the cloud copy, push changes)
     6. Guest -> account migration (with verification)
     7. Sign in / sign up / sign out
     8. Screens (account card, pop-ups, public leaderboard)
   ============================================================================ */
(function () {
  'use strict';

  /* ---------- 1. SETTINGS ------------------------------------------------- */
  var SUPABASE_URL = 'https://awarhwsvwhcbvqvzpneq.supabase.co';
  var SUPABASE_KEY = 'sb_publishable_E565HRaIHa4ZHMSivOXDIA_uVCSAtXw'; // publishable = safe in the browser
  var SYNC_EVERY_MS = 60 * 1000;       // refresh from the cloud every minute
  var AGES = ['10U', '11-12', '13-14', '15-16', '17-18'];

  var sb = null;                        // the Supabase client (null = accounts unavailable)
  var user = null;                      // the signed-in user (null = Guest Mode)
  var why = '';                         // why accounts are unavailable (for the message)
  var syncing = false, again = false, timer = null, flushTimer = null;
  var draft = null, statusText = '', cloudHasSettings = false, lbState = {key: '', rows: null, msg: ''};
  var C = window.Cloud = {};
  var ui = {};                          // every pop-up lives in "ui" (tests replace these)

  /* ---------- 2. SMALL HELPERS -------------------------------------------- */
  function $(id) { return document.getElementById(id); }
  function A() { return window.AQ; }    // the bridge to index.html
  function esc(s) { // make text safe to put inside HTML
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c];
    });
  }
  function chunks(arr, n) { var out = []; for (var i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }
  function nice(e) {
    var m = (e && (e.message || e.error_description || e.msg)) || String(e);
    if (/failed to fetch|networkerror|load failed|abort|timeout|network request/i.test(m)) return 'offline';
    return m;
  }
  function isOffline(e) { return nice(e) === 'offline'; }
  function validNick(n) { // 2-20 chars, letters/numbers/space . _ -  and never an email
    n = String(n || '').trim();
    return n.length >= 2 && n.length <= 20 && n.indexOf('@') < 0 && /^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u.test(n);
  }
  function timeoutFetch(url, opts) { // never wait forever for the network
    opts = opts || {};
    if (!opts.signal && window.AbortSignal && AbortSignal.timeout) opts = Object.assign({}, opts, {signal: AbortSignal.timeout(20000)});
    return fetch(url, opts);
  }
  function cleanSwim(o) { // only keep the fields we expect, as plain text/numbers
    var t = Number(o && o.timeSec);
    if (!o || !(t > 0 && t < 36000) || !o.dist || !o.stroke || !o.course) return null;
    var c = {id: Number(o.id) || Date.now(), timeSec: t, uid: String(o.uid || A().legacyUid(o)).slice(0, 80)};
    ['dist', 'stroke', 'course', 'date', 'notes', 'swimmerName', 'tier', 'timeFormatted'].forEach(function (k) {
      if (o[k] != null) c[k] = String(o[k]).slice(0, 200);
    });
    return c;
  }
  function rowFor(swim) { // what we store in the swim_logs table
    var data = Object.assign({}, swim); delete data.rowId;
    return {user_id: user.id, uid: swim.uid, log_data: data};
  }

  /* ---------- 3. PENDING-CHANGES QUEUE ------------------------------------ */
  // Every change (add, delete...) is first written to a small to-do list saved in
  // this browser. It is only removed AFTER the cloud confirms it. So if you are
  // offline, nothing is lost: the list is retried at the next sync.
  function readQ() { return A().store.get('pending', user.id, []); }
  function writeQ(q) { A().store.set('pending', user.id, q); }
  function enqueue(op) {
    if (!user) return;
    op.n = Date.now() + '-' + Math.random().toString(36).slice(2, 8);   // unique tag for this change
    var q = readQ();
    if (op.t === 'settings' || op.t === 'public') q = q.filter(function (o) { return o.t !== op.t; });
    if (op.t === 'clear') q = q.filter(function (o) { return o.t === 'settings' || o.t === 'public'; });
    q.push(op); writeQ(q);
    clearTimeout(flushTimer); flushTimer = setTimeout(function () { sync('change'); }, 400);
  }
  function publicOn() { return !!user && A().store.get('settings', user.id, {}).publicOn === true; }

  // index.html calls this after every change the person makes.
  C.notify = function (kind, p) {
    if (!user) return;                  // guests: nothing to send
    if (kind === 'add') enqueue({t: 'add', swim: p});
    else if (kind === 'addMany') p.forEach(function (s) { enqueue({t: 'add', swim: s}); });
    else if (kind === 'del') enqueue({t: 'del', uid: p.uid});
    else if (kind === 'clear') enqueue({t: 'clear'});
    else if (kind === 'settings') enqueue({t: 'settings'});
    if (kind !== 'settings' && publicOn()) enqueue({t: 'public'});
  };

  /* ---------- 4. TALKING TO THE DATABASE ---------------------------------- */
  async function pullAll() { // read ALL my swims (1000 at a time)
    var out = [], from = 0;
    for (;;) {
      var r = await sb.from('swim_logs').select('id, uid, log_data').eq('user_id', user.id)
        .order('created_at', {ascending: true}).range(from, from + 999);
      if (r.error) throw r.error;
      r.data.forEach(function (row) {
        var s = cleanSwim(Object.assign({}, row.log_data, {uid: row.uid || (row.log_data && row.log_data.uid)}));
        if (s) { s.rowId = row.id; out.push(s); }
      });
      if (r.data.length < 1000) break;
      from += 1000;
    }
    return out;
  }
  async function pullSettings() {
    var r = await sb.from('user_settings').select('settings').eq('user_id', user.id).maybeSingle();
    if (r.error) throw r.error;
    cloudHasSettings = !!r.data;
    return r.data ? r.data.settings : null;
  }
  function localSettings() {
    var a = A(), s = a.store.get('settings', user.id, {});
    return {v: 1, profile: a.profile(), goal: a.goal(), publicOn: s.publicOn === true, nickname: s.nickname || ''};
  }
  function pushSettings() {
    return sb.from('user_settings').upsert({user_id: user.id, settings: localSettings(), updated_at: new Date().toISOString()}, {onConflict: 'user_id'});
  }
  function bests(list) { // best time per event
    var m = {};
    list.forEach(function (s) {
      var k = s.dist + '|' + s.stroke + '|' + s.course;
      if (!m[k] || s.timeSec < m[k].best_sec) m[k] = {dist: s.dist, stroke: s.stroke, course: s.course, best_sec: s.timeSec};
    });
    return m;
  }
  // Publishes ONLY nickname + best time per event. Nothing else ever leaves.
  async function pushPublic() {
    var st = A().store.get('settings', user.id, {});
    var mine = await sb.from('public_results').select('dist,stroke,course').eq('user_id', user.id);
    if (mine.error) return mine;
    if (st.publicOn !== true || !validNick(st.nickname)) return sb.from('public_results').delete().eq('user_id', user.id);
    var want = bests(A().logs()), now = new Date().toISOString();
    var rows = Object.keys(want).map(function (k) {
      var w = want[k];
      return {user_id: user.id, dist: w.dist, stroke: w.stroke, course: w.course, nickname: st.nickname.trim(), best_sec: w.best_sec, updated_at: now};
    });
    if (rows.length) {
      var u = await sb.from('public_results').upsert(rows, {onConflict: 'user_id,dist,stroke,course'});
      if (u.error) return u;
    }
    for (var i = 0; i < mine.data.length; i++) { // remove events I no longer have
      var m = mine.data[i];
      if (!want[m.dist + '|' + m.stroke + '|' + m.course]) {
        var d = await sb.from('public_results').delete().eq('user_id', user.id).eq('dist', m.dist).eq('stroke', m.stroke).eq('course', m.course);
        if (d.error) return d;
      }
    }
    return {error: null};
  }
  async function runOp(op) { // do ONE queued change
    var r;
    if (op.t === 'add') r = await sb.from('swim_logs').upsert([rowFor(op.swim)], {onConflict: 'user_id,uid', ignoreDuplicates: true});
    else if (op.t === 'del') r = await sb.from('swim_logs').delete().eq('user_id', user.id).eq('uid', op.uid);
    else if (op.t === 'clear') r = await sb.from('swim_logs').delete().eq('user_id', user.id);
    else if (op.t === 'settings') r = await pushSettings();
    else if (op.t === 'public') r = await pushPublic();
    if (r && r.error) throw r.error;
  }

  /* ---------- 5. SYNC ----------------------------------------------------- */
  async function flush() { // send queued changes one by one; stop at the first failure
    var q = readQ();
    while (q.length) {
      var op = q[0];
      await runOp(op);
      q = readQ().filter(function (o) { return o.n !== op.n; }); writeQ(q);   // remove only the change that succeeded
    }
  }
  function applyPending(list, q) { // put not-yet-uploaded changes on top of the cloud copy
    var map = new Map(list.map(function (s) { return [s.uid, s]; }));
    q.forEach(function (op) {
      if (op.t === 'add') map.set(op.swim.uid, op.swim);
      else if (op.t === 'del') map.delete(op.uid);
      else if (op.t === 'clear') map.clear();
    });
    var out = Array.from(map.values()), seen = new Set();
    out.forEach(function (s) { while (seen.has(s.id)) s.id += 1; seen.add(s.id); }); // keep local ids unique
    return out.sort(function (a, b) { return b.id - a.id; });
  }
  function setStatus(t) { statusText = t; C.renderAccount(); }
  async function sync(reason) {
    if (!user || !sb) return;
    if (syncing) { again = true; return; }
    syncing = true; setStatus('Syncing...');
    try {
      await flush();
      var swims = await pullAll(), settings = await pullSettings();
      var q = readQ(), list = applyPending(swims, q), a = A();
      if (JSON.stringify(list) !== JSON.stringify(a.logs())) a.replaceLogs(list);
      if (settings && !q.some(function (o) { return o.t === 'settings'; })) {
        var s = a.store.get('settings', user.id, {});
        a.store.set('settings', user.id, {publicOn: settings.publicOn === true, nickname: validNick(settings.nickname) ? settings.nickname : (s.nickname || '')});
        a.applySettings(settings.profile, settings.goal);
      }
      setStatus('Synced ' + new Date().toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}));
    } catch (e) {
      setStatus(isOffline(e) ? 'Offline: changes will sync when you are back online' : 'Sync problem: ' + nice(e) + ' (will retry)');
    }
    syncing = false;
    if (again) { again = false; setTimeout(function () { sync('again'); }, 300); }
  }
  C.syncNow = function () { sync('button'); };
  function startTimers() {
    stopTimers();
    timer = setInterval(function () { if (!document.hidden) sync('timer'); }, SYNC_EVERY_MS);
  }
  function stopTimers() { clearInterval(timer); clearTimeout(flushTimer); timer = null; }

  /* ---------- 6. GUEST -> ACCOUNT MIGRATION ------------------------------- */
  // Rules (your requirements):
  //  - ALWAYS ask first, and show how many swims will move.
  //  - Upload, then READ BACK from the cloud to verify every swim is there.
  //  - NEVER delete guest swims. They stay as a backup until the person clears them.
  //  - A tiny note "this swim was uploaded by account X" stops the same guest
  //    swims from ever being offered to a DIFFERENT account on this browser.
  function uploadedMap() { try { return JSON.parse(localStorage.getItem('aqua_guest_uploaded') || '{}'); } catch (e) { return {}; } }
  function saveUploadedMap(m) { localStorage.setItem('aqua_guest_uploaded', JSON.stringify(m)); }
  function guestSwims() {
    var a = A(), g = a.store.get('logs', 'guest', []);
    if (a.ensureUids(g)) a.store.set('logs', 'guest', g);   // adds an "uid" field only (nothing removed)
    return g;
  }
  function eligibleGuest() { // guest swims that were never uploaded anywhere
    var map = uploadedMap(), have = new Set(A().logs().map(function (s) { return s.uid; })), me = A().hash(user.id), changed = false;
    var out = guestSwims().filter(function (s) {
      if (map[s.uid]) return false;
      if (have.has(s.uid)) { map[s.uid] = me; changed = true; return false; }   // already in this account
      return true;
    });
    if (changed) saveUploadedMap(map);
    return out;
  }
  function backupSwims(forUser) { // guest swims kept as backup (optionally only those uploaded by one account)
    var map = uploadedMap(), me = forUser ? A().hash(forUser.id) : null;
    return guestSwims().filter(function (s) { return map[s.uid] && (!me || map[s.uid] === me); });
  }
  async function uploadAndVerify(list) {
    var rows = list.map(rowFor), i, r;
    var parts = chunks(rows, 200);
    for (i = 0; i < parts.length; i++) {
      r = await sb.from('swim_logs').upsert(parts[i], {onConflict: 'user_id,uid', ignoreDuplicates: true});
      if (r.error) throw r.error;
    }
    var found = new Set(), idParts = chunks(list.map(function (s) { return s.uid; }), 50);
    for (i = 0; i < idParts.length; i++) {   // VERIFY: ask the cloud which of these now exist
      r = await sb.from('swim_logs').select('uid').eq('user_id', user.id).in('uid', idParts[i]);
      if (r.error) throw r.error;
      r.data.forEach(function (d) { found.add(d.uid); });
    }
    return list.filter(function (s) { return !found.has(s.uid); });   // = the ones NOT confirmed
  }
  async function offerMigration() {
    if (!user) return;
    var list = eligibleGuest();
    if (!list.length) return;
    var choice = await ui.migrate({count: list.length, canCopyProfile: !cloudHasSettings});
    if (!choice || !choice.upload) return;
    var a = A();
    if (choice.backup) a.backup(list);
    ui.busy('Uploading ' + list.length + ' swims...');
    try {
      var missing = await uploadAndVerify(list);
      if (missing.length) { ui.info('Not finished', 'Only ' + (list.length - missing.length) + ' of ' + list.length + ' swims could be confirmed in your account. Nothing was changed on this device. Please try again from the Account panel.'); return; }
      var map = uploadedMap(), me = a.hash(user.id);
      list.forEach(function (s) { map[s.uid] = me; });
      saveUploadedMap(map);
      if (choice.profile && !cloudHasSettings) { a.applyGuestProfile(); enqueue({t: 'settings'}); }
      await sync('migrated');
      ui.info('Upload verified', 'All ' + list.length + ' swims are now safely in your account. Your guest copies are still on this device as a backup. You can clear them any time from the Account panel.');
    } catch (e) {
      ui.info('Upload did not finish', (isOffline(e) ? 'You seem to be offline. ' : nice(e) + '. ') + 'Your guest swims are untouched. You can try again from the Account panel.');
    }
    C.renderAccount();
  }
  C.uploadGuest = function () { offerMigration(); };
  C.clearBackup = async function () {
    var list = user ? backupSwims(user) : backupSwims(null);
    if (!list.length) return;
    var ok = await ui.confirm('Clear guest backup?', 'This removes ' + list.length + ' backup cop' + (list.length === 1 ? 'y' : 'ies') + ' from this browser. The swims stay in your account.', 'Clear ' + list.length);
    if (!ok) return;
    removeBackup(list);
  };
  function removeBackup(list) {
    var a = A(), gone = new Set(list.map(function (s) { return s.uid; })), map = uploadedMap();
    a.store.set('logs', 'guest', a.store.get('logs', 'guest', []).filter(function (s) { return !gone.has(s.uid); }));
    gone.forEach(function (u) { delete map[u]; });
    saveUploadedMap(map);
    if (a.getScope() === 'guest') a.setScope('guest'); else C.renderAccount();
  }

  /* ---------- 7. SIGN IN / SIGN UP / SIGN OUT ----------------------------- */
  C.isSignedIn = function () { return !!user; };
  function redirectUrl() { return location.origin + location.pathname; }
  function wantMigrationOffer() { try { localStorage.setItem('aqua_offer_migration', '1'); } catch (e) {} }
  async function enterAccount(u) {
    var a = A();
    if (user && user.id !== u.id) leaveAccount();               // another person: wipe the old cache first
    a.store.removeOtherAccounts(u.id);                          // no other account's data stays in this browser
    user = u; a.setScope(u.id); startTimers(); C.renderAccount(); C.renderHeader();
    await sync('signin');
    if (localStorage.getItem('aqua_offer_migration') === '1') {  // only right after a real sign-in
      localStorage.removeItem('aqua_offer_migration');
      await offerMigration();
    }
    C.refreshLeaderboard(true);
  }
  function leaveAccount() {
    var a = A(), old = user;
    stopTimers(); user = null; cloudHasSettings = false; draft = null;
    if (old) a.store.removeAccount(old.id);                     // erase this account's copy from the browser
    a.setScope('guest');                                        // back to Guest data only
    C.renderAccount(); C.renderHeader();
  }
  function onAuth(event, session) {
    if (event === 'PASSWORD_RECOVERY') { ui.newPassword(); }
    var u = session && session.user;
    if (u) { if (!user || user.id !== u.id) enterAccount(u); else user = u; }
    else if (user) leaveAccount();
  }
  function authMsg(t, bad) { var m = $('cl-msg'); if (m) { m.textContent = t; m.className = 'text-xs ' + (bad ? 'text-rose-300' : 'text-cyan-300'); } }
  function authInputs() { return {email: ($('cl-email') || {}).value || '', pass: ($('cl-pass') || {}).value || ''}; }
  C.doSignIn = async function () {
    var f = authInputs(); if (!f.email || !f.pass) return authMsg('Enter your email and password.', true);
    authMsg('Signing in...'); wantMigrationOffer();
    var r = await sb.auth.signInWithPassword({email: f.email.trim(), password: f.pass});
    if (r.error) return authMsg(isOffline(r.error) ? 'You seem to be offline.' : 'Could not sign in. Check your email and password, and make sure you confirmed your email.', true);
    C.closeAuth();
  };
  C.doSignUp = async function () {
    var f = authInputs(); if (!f.email || f.pass.length < 8) return authMsg('Enter your email and a password with at least 8 characters.', true);
    authMsg('Creating account...'); wantMigrationOffer();
    var r = await sb.auth.signUp({email: f.email.trim(), password: f.pass, options: {emailRedirectTo: redirectUrl()}});
    if (r.error) return authMsg(isOffline(r.error) ? 'You seem to be offline.' : nice(r.error), true);
    if (r.data && r.data.session) { C.closeAuth(); return; }   // email confirmation is OFF: already signed in
    authMsg('Almost done! Open the email we sent and click the link, then come back and sign in. Your guest swims stay safely on this device. (If this email already has an account, use Sign in or Forgot password.)');
  };
  C.doGoogle = async function () {
    wantMigrationOffer();
    var r = await sb.auth.signInWithOAuth({provider: 'google', options: {redirectTo: redirectUrl()}});
    if (r.error) authMsg('Google sign-in is not available: ' + nice(r.error), true);
  };
  C.doForgot = async function () {
    var f = authInputs(); if (!f.email) return authMsg('Type your email first, then press Forgot password.', true);
    var r = await sb.auth.resetPasswordForEmail(f.email.trim(), {redirectTo: redirectUrl()});
    authMsg(r.error ? nice(r.error) : 'If that email has an account, a reset link is on its way.', !!r.error);
  };
  C.signOut = async function () {
    if (!user) return;
    try { await flush(); } catch (e) {}
    if (readQ().length && !(await ui.confirm('Some changes are not uploaded yet', 'You are offline or the cloud did not answer. If you sign out now, ' + readQ().length + ' recent change(s) will be lost.', 'Sign out anyway'))) return;
    var backups = backupSwims(user);
    if (backups.length) {
      var pick = await ui.signOutChoice(backups.length);
      if (pick === 'cancel') return;
      if (pick === 'clear') removeBackup(backups);
    }
    try { await sb.auth.signOut(); } catch (e) {}
    if (user) leaveAccount();                                   // make sure we leave even if the network failed
  };
  C.deleteCloudData = async function () {
    if (!user || !(await ui.confirm('Delete my cloud data?', 'This permanently deletes all swims, settings and public results stored in your account. Your login stays. Guest backup copies on this device are not touched.', 'Delete'))) return;
    try {
      var t = ['swim_logs', 'public_results', 'user_settings'];
      for (var i = 0; i < t.length; i++) { var r = await sb.from(t[i]).delete().eq('user_id', user.id); if (r.error) throw r.error; }
      writeQ([]); A().store.set('settings', user.id, {}); A().replaceLogs([]);
      ui.info('Done', 'Your cloud data was deleted.');
    } catch (e) { ui.info('Could not delete', nice(e)); }
  };
  C.savePublic = async function () {
    var on = $('cl-pub-on').checked, nick = ($('cl-nick').value || '').trim();
    draft = null;
    if (on && !validNick(nick)) return ui.info('Pick a nickname', 'Use 2 to 20 letters or numbers. Please do not use your email or your full name.');
    A().store.set('settings', user.id, {publicOn: on, nickname: nick});
    enqueue({t: 'settings'}); enqueue({t: 'public'});
    ui.info(on ? 'Public leaderboard is ON' : 'Public leaderboard is OFF', on ? 'Your nickname and best times will appear on the public leaderboard.' : 'Your public entries are being removed.');
    C.renderAccount();
  };

  /* ---------- 8. SCREENS --------------------------------------------------- */
  var BTN = 'px-4 py-2 rounded-lg text-sm font-bold ';
  var B1 = BTN + 'bg-cyan-500 hover:bg-cyan-400 text-slate-950', B2 = BTN + 'bg-slate-700 hover:bg-slate-600 text-white', B3 = BTN + 'bg-rose-600 hover:bg-rose-500 text-white';
  var INPUT = 'w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white';

  function modal(title, body, buttons) { // a simple pop-up that returns the chosen value
    return new Promise(function (resolve) {
      var o = document.createElement('div');
      o.className = 'fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/70';
      o.innerHTML = '<div class="glass-card rounded-2xl p-6 w-full max-w-md max-h-[90vh] overflow-y-auto space-y-3"><h3 class="font-bold text-white text-lg">' + esc(title) + '</h3><div class="text-sm text-slate-300 space-y-2">' + body + '</div><div class="flex flex-wrap gap-2 justify-end pt-2" data-btns></div></div>';
      var box = o.querySelector('[data-btns]');
      buttons.forEach(function (b) {
        var el = document.createElement('button'); el.type = 'button'; el.className = b.cls || B2; el.textContent = b.label;
        el.onclick = function () { var v = b.collect ? b.collect(o) : b.value; o.remove(); resolve(v); };
        box.appendChild(el);
      });
      document.body.appendChild(o);
    });
  }
  ui.confirm = function (title, text, okLabel) { return modal(title, '<p>' + esc(text) + '</p>', [{label: 'Cancel', value: false}, {label: okLabel || 'OK', value: true, cls: B3}]); };
  ui.info = function (title, text) { var b = document.getElementById('cl-busy'); if (b) b.remove(); return modal(title, '<p>' + esc(text) + '</p>', [{label: 'OK', value: true, cls: B1}]); };
  ui.busy = function (text) {
    var o = document.createElement('div'); o.id = 'cl-busy';
    o.className = 'fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/70';
    o.innerHTML = '<div class="glass-card rounded-2xl p-6 text-white text-sm">' + esc(text) + '</div>'; document.body.appendChild(o);
  };
  ui.migrate = function (info) {
    var n = info.count, body = '<p>You have <b class="text-white">' + n + ' guest swim' + (n === 1 ? '' : 's') + '</b> on this device that ' + (n === 1 ? 'is' : 'are') + ' not in your account yet.</p><p>Upload ' + (n === 1 ? 'it' : 'them') + ' to your account? We will check that every swim arrived. <b class="text-white">Your guest copies are NOT deleted.</b></p>' +
      '<label class="flex gap-2 items-start"><input type="checkbox" id="cl-m-backup" checked class="mt-1"> <span>Download a backup file first (recommended)</span></label>' +
      (info.canCopyProfile ? '<label class="flex gap-2 items-start"><input type="checkbox" id="cl-m-prof" checked class="mt-1"> <span>Also use my guest profile and weekly goal for this account</span></label>' : '');
    return modal('Upload your guest swims?', body, [
      {label: 'Not now', value: {upload: false}},
      {label: 'Upload ' + n + ' swim' + (n === 1 ? '' : 's'), cls: B1, collect: function (o) { return {upload: true, backup: o.querySelector('#cl-m-backup').checked, profile: !!(o.querySelector('#cl-m-prof') && o.querySelector('#cl-m-prof').checked)}; }}]);
  };
  ui.signOutChoice = function (n) {
    return modal('Sign out', '<p>This device still holds <b class="text-white">' + n + ' guest backup cop' + (n === 1 ? 'y' : 'ies') + '</b> of swims that are in your account. Anyone using AquaTrack as a guest here could see them.</p><p>On a shared computer, choose "Sign out and clear".</p>', [
      {label: 'Cancel', value: 'cancel'}, {label: 'Sign out, keep backup', value: 'keep'}, {label: 'Sign out and clear', value: 'clear', cls: B1}]);
  };
  ui.newPassword = function () {
    modal('Choose a new password', '<input id="cl-newpw" type="password" minlength="8" autocomplete="new-password" placeholder="New password (8+ characters)" class="' + INPUT + '">', [
      {label: 'Cancel', value: null}, {label: 'Save password', cls: B1, collect: function (o) { return o.querySelector('#cl-newpw').value; }}]).then(async function (pw) {
      if (!pw) return;
      if (pw.length < 8) return ui.info('Too short', 'Use at least 8 characters.');
      var r = await sb.auth.updateUser({password: pw});
      ui.info(r.error ? 'Could not change password' : 'Password changed', r.error ? nice(r.error) : 'You can now use your new password.');
    });
  };

  C.openAuth = function () {
    if (!sb) return;
    C.closeAuth();
    var o = document.createElement('div'); o.id = 'cl-auth';
    o.className = 'fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/70';
    o.innerHTML = '<div class="glass-card rounded-2xl p-6 w-full max-w-sm max-h-[90vh] overflow-y-auto space-y-3"><h3 class="font-bold text-white text-lg">Account</h3>' +
      '<p class="text-xs text-slate-400">Accounts are optional. You can keep using AquaTrack as a guest forever.</p>' +
      '<input id="cl-email" type="email" autocomplete="email" placeholder="Email" class="' + INPUT + '">' +
      '<input id="cl-pass" type="password" autocomplete="current-password" placeholder="Password (8+ characters)" class="' + INPUT + '">' +
      '<div id="cl-msg" class="text-xs text-cyan-300"></div>' +
      '<div class="flex gap-2"><button class="' + B1 + ' flex-1" onclick="Cloud.doSignIn()">Sign in</button><button class="' + B2 + ' flex-1" onclick="Cloud.doSignUp()">Create account</button></div>' +
      '<button class="' + B2 + ' w-full" onclick="Cloud.doGoogle()">Continue with Google</button>' +
      '<div class="flex justify-between text-xs"><button class="text-cyan-300 underline" onclick="Cloud.doForgot()">Forgot password?</button><button class="text-slate-400 underline" onclick="Cloud.closeAuth()">Cancel</button></div></div>';
    document.body.appendChild(o);
  };
  C.closeAuth = function () { var o = $('cl-auth'); if (o) o.remove(); };
  C.openAccount = function () {
    if (!sb) { if (window.switchTab) switchTab('profile'); return; }
    if (user) { if (window.switchTab) switchTab('profile'); var c = $('cl-account'); if (c && c.scrollIntoView) c.scrollIntoView({behavior: 'smooth'}); }
    else C.openAuth();
  };

  C.renderHeader = function () {
    var m = $('cl-hdr-mount'); if (!m) return;
    m.hidden = !sb;
    if (!sb) { m.innerHTML = ''; return; }
    m.innerHTML = '<button onclick="Cloud.openAccount()" class="flex items-center gap-1.5 bg-slate-900/80 hover:bg-slate-800 border border-slate-600 px-3 py-1.5 rounded-xl text-xs font-medium text-slate-200 transition">' +
      (user ? '<span class="w-2 h-2 rounded-full bg-emerald-400"></span> Account' : 'Sign in') + '</button>';
  };
  C.renderAccount = function () {
    var box = $('cl-account'); if (!box) return;
    var head = '<h3 class="font-bold text-white flex items-center gap-2"><i data-lucide="cloud" class="w-5 h-5 text-brand-400"></i> Account</h3>', html;
    if (!sb) {
      html = head + '<p class="text-sm text-slate-300">' + (why === 'claude' ? 'Accounts only work on your hosted copy of AquaTrack, not inside the Claude page.' : 'Accounts are not available right now (no connection to the cloud).') + ' <b class="text-white">Guest Mode works fully:</b> your swims are saved in this browser.</p>';
    } else if (!user) {
      var nb = backupSwims(null).length;
      html = head + '<p class="text-sm text-slate-300">You are using AquaTrack as a <b class="text-white">guest</b>. Your swims are saved in this browser only. An account is optional. Create one only if you want your swims on other devices.</p>' +
        '<div class="flex flex-wrap gap-2"><button class="' + B1 + '" onclick="Cloud.openAuth()">Create account</button><button class="' + B2 + '" onclick="Cloud.openAuth()">Sign in</button></div>' +
        (nb ? '<p class="text-xs text-slate-400">' + nb + ' swim' + (nb === 1 ? '' : 's') + ' on this device ' + (nb === 1 ? 'is' : 'are') + ' also backed up in an account. <button class="text-cyan-300 underline" onclick="Cloud.clearBackup()">Clear backup copies</button></p>' : '');
    } else {
      var st = A().store.get('settings', user.id, {}), el = eligibleGuest().length, bk = backupSwims(user).length;
      var nickEl = $('cl-nick'), onEl = $('cl-pub-on');
      if (nickEl && onEl) draft = {nick: nickEl.value, on: onEl.checked};   // keep what the person is typing when the card refreshes
      var shownNick = draft ? draft.nick : (st.nickname || ''), shownOn = draft ? draft.on : st.publicOn === true;
      html = head + '<p class="text-sm text-slate-300">Signed in as <b class="text-white">' + esc(user.email || 'your account') + '</b></p>' +
        '<div class="flex flex-wrap items-center gap-2"><span class="text-xs text-emerald-300">' + esc(statusText || 'Ready') + '</span><button class="' + B2 + '" onclick="Cloud.syncNow()">Sync now</button><button class="' + B2 + '" onclick="Cloud.signOut()">Sign out</button></div>' +
        '<div class="rounded-xl bg-slate-950/60 border border-slate-800 p-3 space-y-2"><div class="text-sm font-bold text-white">Public leaderboard</div>' +
        '<p class="text-xs text-slate-400">Off by default. If you turn it on, only your <b>nickname</b> and your <b>best time per event</b> are shown to everyone, including guests. Never your email, age, gender, notes or dates. Times are self-reported.</p>' +
        '<label class="flex gap-2 items-center text-sm text-slate-200"><input type="checkbox" id="cl-pub-on" ' + (shownOn ? 'checked' : '') + '> Show my best times publicly</label>' +
        '<input id="cl-nick" maxlength="20" placeholder="Nickname (not your full name or email)" value="' + esc(shownNick) + '" class="' + INPUT + '"><button class="' + B1 + '" onclick="Cloud.savePublic()">Save</button></div>' +
        (el ? '<div class="text-sm text-slate-300">' + el + ' guest swim' + (el === 1 ? '' : 's') + ' on this device ' + (el === 1 ? 'is' : 'are') + ' not in your account. <button class="text-cyan-300 underline" onclick="Cloud.uploadGuest()">Upload them...</button></div>' : '') +
        (bk ? '<div class="text-xs text-slate-400">' + bk + ' guest backup cop' + (bk === 1 ? 'y' : 'ies') + ' kept on this device. <button class="text-cyan-300 underline" onclick="Cloud.clearBackup()">Clear backup</button></div>' : '') +
        '<button class="text-xs text-rose-300 underline" onclick="Cloud.deleteCloudData()">Delete all my cloud data</button>';
    }
    box.innerHTML = '<div class="glass-card rounded-2xl p-6 space-y-3">' + html + '</div>';
    if (window.lucide) try { lucide.createIcons(); } catch (e) {}
  };

  /* ---- public leaderboard (anyone can read, including guests) ---- */
  C.refreshLeaderboard = function (force) {
    var box = $('cl-lb'); if (!box) return;
    var tab = $('tab-leaderboard'); if (tab && tab.classList.contains('hidden') && !force) return;
    var dist = $('leader-dist').value, stroke = $('leader-stroke').value, course = $('leader-course').value, key = dist + '|' + stroke + '|' + course;
    var head = '<div class="flex flex-wrap items-center justify-between gap-2"><h3 class="font-bold text-white flex items-center gap-2"><i data-lucide="globe" class="w-5 h-5 text-brand-400"></i> Public Leaderboard: ' + esc(window.evName ? evName(dist, stroke) : dist + ' ' + stroke) + ' ' + esc(course) + '</h3><button class="text-xs text-cyan-300 underline" onclick="Cloud.refreshLeaderboard(true)">Refresh</button></div>' +
      '<p class="text-xs text-slate-400">Nickname and best time only. Swimmers choose to appear here. Times are self-reported and not verified.</p>';
    function paint(body) { box.innerHTML = '<div class="glass-card rounded-2xl p-5 space-y-3">' + head + body + '</div>'; if (window.lucide) try { lucide.createIcons(); } catch (e) {} }
    if (!sb) return paint('<p class="text-sm text-slate-400">The public leaderboard needs a connection to the cloud, which is not available right now. Everything else in AquaTrack still works.</p>');
    if (!force && lbState.key === key && lbState.rows) return paint(lbRows(lbState.rows));
    paint('<p class="text-sm text-slate-400">Loading...</p>');
    sb.rpc('get_public_leaderboard', {p_dist: dist, p_stroke: stroke, p_course: course, p_limit: 50}).then(function (r) {
      if (r.error) { lbState = {key: '', rows: null}; return paint('<p class="text-sm text-slate-400">' + (isOffline(r.error) ? 'You seem to be offline.' : 'The public leaderboard is not set up yet or could not be loaded.') + '</p>'); }
      lbState = {key: key, rows: r.data || []}; paint(lbRows(lbState.rows));
    }, function () { paint('<p class="text-sm text-slate-400">Could not load the leaderboard. Check your connection.</p>'); });
  };
  function lbRows(rows) {
    if (!rows.length) return '<p class="text-sm text-slate-400">Nobody has shared a time for this event yet.</p>';
    var mine = user ? (A().store.get('settings', user.id, {}).nickname || '') : '';
    return '<div class="overflow-x-auto"><table class="w-full text-left text-sm"><thead><tr class="text-xs text-slate-400 border-b border-slate-700"><th class="py-2 px-3">#</th><th class="py-2 px-3">Nickname</th><th class="py-2 px-3">Best</th></tr></thead><tbody>' +
      rows.map(function (r, i) {
        var t = Number(r.best_sec);
        return '<tr class="' + (mine && r.nickname === mine && publicOn() ? 'bg-cyan-400/10' : 'hover:bg-slate-800/40') + '"><td class="py-2 px-3 font-black text-white">' + (i + 1) + '</td><td class="py-2 px-3 text-white">' + esc(r.nickname) + (mine && r.nickname === mine && publicOn() ? ' (you)' : '') + '</td><td class="py-2 px-3 font-mono">' + esc(window.formatTime ? formatTime(t) : t.toFixed(2)) + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  /* ---------- START -------------------------------------------------------- */
  C.init = function () {
    if (window.claude) { why = 'claude'; }
    else if (!window.supabase || !window.supabase.createClient) { why = 'library'; }
    else {
      try {
        sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
          auth: {persistSession: true, autoRefreshToken: true, detectSessionInUrl: true},
          global: {fetch: timeoutFetch}
        });
      } catch (e) { sb = null; why = 'library'; }
    }
    if (sb) {
      sb.auth.onAuthStateChange(function (event, session) { setTimeout(function () { onAuth(event, session); }, 0); }); // setTimeout avoids a known Supabase deadlock
      document.addEventListener('visibilitychange', function () { if (!document.hidden) sync('focus'); });
      window.addEventListener('focus', function () { sync('focus'); });
      window.addEventListener('online', function () { sync('online'); });
      // If Google/Supabase sent the person back with an error in the address, show it in the Account pop-up.
      (function () {
        var q = new URLSearchParams(location.search), h = new URLSearchParams(location.hash.replace(/^#/, ''));
        var d = q.get('error_description') || h.get('error_description');
        if (!d) return;
        try { history.replaceState(null, '', location.pathname); } catch (e) {}
        var msg = /exchange external code/i.test(d)
          ? 'Google sign-in could not finish. This is a setup problem in Supabase or Google (Client ID, Client Secret or redirect URL), not something you did wrong. Details: ' + d
          : 'Sign-in problem: ' + d;
        setTimeout(function () { C.openAuth(); authMsg(msg, true); }, 400);
      })();
    }
    C.renderHeader(); C.renderAccount(); C.refreshLeaderboard(false);
  };

  // Handles used by the automatic tests only.
  C._test = {
    setClient: function (c) { sb = c; }, setUser: function (u) { user = u; }, getUser: function () { return user; },
    ui: ui, onAuth: onAuth, sync: sync, flush: flush, offerMigration: offerMigration, uploadAndVerify: uploadAndVerify,
    readQ: function () { return readQ(); }, eligibleGuest: eligibleGuest, backupSwims: backupSwims, uploadedMap: uploadedMap,
    validNick: validNick, enterAccount: enterAccount, leaveAccount: leaveAccount, applyPending: applyPending, pushPublic: pushPublic,
    runOpEnabled: true
  };
})();
