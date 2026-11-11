// DSi Wallet payment reminders by Gmail. Google Apps Script runs this once a day and emails you.
// Setup: README, section 3. Paste this file into a new Apps Script project.

function sendDueReminders() {
  const folders = DriveApp.getFoldersByName('DSi Wallet');
  if (!folders.hasNext()) return;                       // the app has not synced yet
  const files = folders.next().getFilesByName('dues.json');
  if (!files.hasNext()) return;
  const data = JSON.parse(files.next().getBlob().getDataAsString());
  // Remind about anything due within 3 days, and anything overdue.
  const soon = data.items.filter(i => i.overdue || i.days <= 3);
  if (!soon.length) return;
  const lines = soon.map(i => {
    const when = i.overdue ? 'OVERDUE since ' + i.date : (i.days === 0 ? 'due today' : 'due ' + i.date + ' (in ' + i.days + ' day(s))');
    return '• ' + i.name + ': ' + i.amountText + ' — ' + when + (i.count > 1 ? ' [' + i.count + ' items]' : '');
  }).join('\n');
  MailApp.sendEmail(Session.getActiveUser().getEmail(), 'DSi Wallet: payments due', 'Payments that need attention:\n\n' + lines + '\n\nOpen DSi Wallet to see details.');
}

// Run once by hand to set this up: it creates the daily trigger.
function setupDailyReminder() {
  ScriptApp.getProjectTriggers().forEach(t => { if (t.getHandlerFunction() === 'sendDueReminders') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('sendDueReminders').timeBased().everyDays(1).atHour(8).create();
}
