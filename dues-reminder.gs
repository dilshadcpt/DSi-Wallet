// DSi Digital payment reminders. Runs once a day (setupDailyReminder) and sends:
//   1. an email (always, if there is anything due)
//   2. a WhatsApp message (if WhatsApp is set up, see README section 9)
//   3. a notification on each PC or phone that turned reminders on (if the push relay is set up)
// It reads the files the app writes to your Drive: DSi Wallet/dues.json and DSi Wallet/subscriptions.json.

function sendDueReminders() {
  const props = PropertiesService.getScriptProperties();
  const folder = folderNamed_('DSi Wallet');
  if (!folder) return;                                   // the app has not synced yet
  const duesFile = fileNamed_(folder, 'dues.json');
  if (!duesFile) return;
  const data = JSON.parse(duesFile.getBlob().getDataAsString());
  // Remind about anything overdue or due within 3 days.
  const soon = data.items.filter(i => i.overdue || i.days <= 3);
  if (!soon.length) return;

  const lines = soon.map(i => {
    const when = i.overdue ? 'OVERDUE since ' + i.date : (i.days === 0 ? 'due today' : 'due ' + i.date + ' (in ' + i.days + ' day(s))');
    return i.name + ': ' + i.amountText + ' - ' + when + (i.count > 1 ? ' [' + i.count + ' items]' : '');
  });
  const title = 'DSi Digital: payments due';
  const text = lines.join('\n');

  MailApp.sendEmail(Session.getActiveUser().getEmail(), title, 'Payments that need attention:\n\n' + text + '\n\nOpen DSi Digital to see details.');
  sendWhatsApp_(props, lines);
  sendPushToDevices_(props, folder, { title: title, body: lines.slice(0, 3).join('\n') + (lines.length > 3 ? '\n...' : ''), tag: 'dues-' + new Date().toDateString() });
}

// WhatsApp Business Cloud API, template message "payment_reminder" (one body variable). README section 9.
function sendWhatsApp_(props, lines) {
  const token = props.getProperty('WA_TOKEN'), phoneId = props.getProperty('WA_PHONE_ID'), to = props.getProperty('WA_TO');
  if (!token || !phoneId || !to) return;
  const body = {
    messaging_product: 'whatsapp', to: to, type: 'template',
    template: { name: 'payment_reminder', language: { code: 'en' },
      components: [{ type: 'body', parameters: [{ type: 'text', text: lines.join('; ').slice(0, 900) }] }] },
  };
  UrlFetchApp.fetch('https://graph.facebook.com/v20.0/' + phoneId + '/messages', {
    method: 'post', contentType: 'application/json', headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify(body), muteHttpExceptions: true,
  });
}

// Sends the notification to every device in subscriptions.json, through the relay (README section 9).
function sendPushToDevices_(props, folder, payload) {
  const relay = props.getProperty('RELAY_URL'), secret = props.getProperty('RELAY_SECRET');
  const subsFile = fileNamed_(folder, 'subscriptions.json');
  if (!relay || !secret || !subsFile) return;
  let subs = JSON.parse(subsFile.getBlob().getDataAsString());
  const gone = [];
  subs.forEach(sub => {
    const res = UrlFetchApp.fetch(relay + '/send', {
      method: 'post', contentType: 'application/json', headers: { 'x-relay-secret': secret },
      payload: JSON.stringify({ subscription: sub, payload: payload }), muteHttpExceptions: true,
    });
    if (res.getResponseCode() === 404 || res.getResponseCode() === 410) gone.push(sub.endpoint);
  });
  if (gone.length) {   // the device turned reminders off or removed the app
    subs = subs.filter(s => gone.indexOf(s.endpoint) < 0);
    subsFile.setContent(JSON.stringify(subs));
  }
}

function folderNamed_(name) {
  const it = DriveApp.getFoldersByName(name);
  return it.hasNext() ? it.next() : null;
}
function fileNamed_(folder, name) {
  const it = folder.getFilesByName(name);
  return it.hasNext() ? it.next() : null;
}

// Run once by hand to set this up: it creates the daily trigger at 8am.
function setupDailyReminder() {
  ScriptApp.getProjectTriggers().forEach(t => { if (t.getHandlerFunction() === 'sendDueReminders') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('sendDueReminders').timeBased().everyDays(1).atHour(8).create();
}
