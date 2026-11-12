# DSi Wallet

Personal money app for BHD, INR and USD. It works on your PC and phone, works offline, and keeps your data in your own Google Drive.

## 1. Put the app on the internet (free)

Google Drive stores your data, but it cannot host the app itself. Any free HTTPS host works. Two options:

- **GitHub Pages:** create a repository, upload all files in this folder, then go to **Settings → Pages** and publish from the main branch. Your address is `https://YOUR-NAME.github.io/REPO-NAME/`.
- **Cloudflare Pages or Firebase Hosting:** upload the folder in their web console. You get an `https://` address.

Keep the address; you need it in section 2. Install and Google sign-in both require HTTPS.

## 2. Connect Google Drive (once)

1. Go to **console.cloud.google.com** and create a project named *DSi Wallet*.
2. **APIs & Services → Library:** search for *Google Drive API* and enable it.
3. **APIs & Services → OAuth consent screen:** choose *External*, enter the app name and your email, and add your own Google account under **Test users**. Add the two scopes `drive.appdata` and `drive.file` (both are personal-use scopes).
4. **APIs & Services → Credentials → Create credentials → OAuth client ID:** choose *Web application*. Under **Authorized JavaScript origins**, add your site's origin, for example `https://YOUR-NAME.github.io` (no path, no slash at the end).
5. Copy the **Client ID** into `config.js` as `googleClientId`, upload the folder to your host again, then open the app → **More → Connect Google Drive**.

Your data is kept in the app's private Drive folder, which you cannot see in Drive itself. Only the app can read it.

## 3. Payment reminders

Reminders go to email, WhatsApp and each PC or phone. The setup is in section 13.

## 4. Install on your PC and phone

- **PC (Edge or Chrome):** open the address, then install it as an app (Edge: *…* → **Apps** → **Install this site as an app**; Chrome: the install icon in the address bar). It gets its own Start menu icon and window.
- **Android (Chrome):** menu → **Install app**.
- **iPhone (Safari):** Share → **Add to Home Screen**, then open the app from that icon.

Each device connects to Google Drive once (More → Connect Google Drive). After that, changes sync automatically.

## 5. What the app does

- **Home:** totals per currency, this period's income and expenses, and **Payments due soon** (loan instalments and card statements, one line per loan or card).
- **Transactions:** add expenses, income and transfers. Pick a month, a year, custom dates or all dates. Choose a project, a party, an advance or loan, an investment plan, or the card statement being paid.
- **Accounts:** bank, cash, credit card, overdraft and other accounts. Loans and overdrafts are listed here, with interest and the next instalments. Record loan payments from a loan's screen.
- **Projects:** separate books (for example Bahrain and India), each in one currency.
- **More → Records:** parties, budget lines, investment plans, advances and loans given or taken, construction funding (link the income that arrived), and card statements.
- **Reports:** PDF statements for a month or one account. Excel export and import (section 7). Backup file (section 8).

## 6. Bring in data from the old DSi Finance App (once)

1. In the old app, choose **File → Back up now**.
2. Open **Documents → DSi Finance Backups** and take the newest `DSiFinance_….json` file.
3. In DSi Wallet, go to **More → Import old app backup** and choose the file.
4. Check the preview: balances should match the old app. Press **Import**.

Everything comes across: projects, accounts, transactions, loans with their payment split, overdrafts, cards and statements, advances, parties, budgets, investment plans and construction funding.

**Check the dues before relying on them.** Your backup records only one payment on each SBI loan (February 2026), so the later instalments show as overdue. If you paid them outside the old app, record them in DSi Wallet from the loan's screen.

## 7. Excel

- **More → Export to Excel** saves projects, accounts, transactions and a *Read me* sheet.
- **Blank template** gives you empty sheets with the right headings.
- **Import from Excel** checks every row first and lists each problem with its sheet and row. Nothing is saved if any row has a problem.
- Keep the **ID** column when you edit a row, so it updates instead of being added again.

Excel does not include parties, advances, funding, budgets, plans or card statements. The backup file does.

## 8. Backup

**More → Export backup** saves everything to a `.json` file. Keep copies in another place (for example your own Drive or a USB stick). **Restore backup** merges a file into this device: where a record exists in both places, the newer one is kept and nothing is deleted.

## 9. Notes and limits

- The app works fully without Google Drive; sync only copies your data between devices.
- If the same record is changed on two devices, the newer change wins.
- Cross-currency transfers can be imported from the old app but not created in the form.
- Google Drive sync, the Gmail reminder script and the hosting setup were built to match the old app's approach, but they have not yet been run on your own Google account. The first run is the real test.
- The old app's PIN lock is not included.

## 13. Payment reminders: email, WhatsApp and PC or phone

Each channel is optional. Email needs only the Apps Script; the others need the steps below.

**A. Email (already set up in section 3)**
Run `setupDailyReminder` once in Apps Script. You get an email at about 8am when anything is overdue or due within 3 days.

**B. PC and phone notifications (push)**
1. **Make the keys.** Install Node.js from nodejs.org. Open a terminal and run `npx web-push generate-vapid-keys`. Save both keys somewhere private.
2. **Put the public key in the app.** In `config.js`, set `vapidPublicKey` to the public key. Upload the file to GitHub, keeping your `googleClientId` in it.
3. **Create the relay.** Sign up at cloudflare.com (free). Go to **Workers & Pages → Create → Worker**, name it `dsi-push-relay`, click **Edit code**, replace the code with `push-relay/worker.js`, and click **Deploy**.
4. **Add the relay settings.** In the Worker, go to **Settings → Variables and secrets** and add:
   - `VAPID_PUBLIC_KEY` (plain text): the public key
   - `VAPID_PRIVATE_KEY` (secret): the private key
   - `VAPID_SUBJECT` (plain text): `mailto:your-email@example.com`
   - `RELAY_SECRET` (secret): a long random word or number of your choice
5. **Tell Apps Script where the relay is.** In script.google.com, open the project, go to **Project Settings → Script properties** and add:
   - `RELAY_URL`: the Worker's address, shown on its page (for example `https://dsi-push-relay.yourname.workers.dev`)
   - `RELAY_SECRET`: the same value as in step 4
6. **Turn it on for each device.** In the app, go to **More → Payment reminders → Turn on reminders on this device**. Connect Google Drive first. On a PC, use the installed app in Edge or Chrome, and keep background apps switched on in the browser settings. On iPhone, use the Home Screen app, iOS 16.4 or later.
7. **Test it.** Press **Send a test notification** in the app. Then in Apps Script choose `sendDueReminders` and press **Run**.

**C. WhatsApp (Meta's official WhatsApp Business API)**
1. Go to developers.facebook.com, sign in, and create an app of type **Business**. Add the **WhatsApp** product. The API Setup page shows a test phone number, a **Phone number ID** and a temporary token. The temporary token expires after 24 hours; for a permanent token, create a System User in Meta Business Settings.
2. In **WhatsApp Manager → Message templates**, create a template: category **Utility**, name `payment_reminder`, language English, body `Payment reminder: {{1}}`. Submit it and wait for approval.
3. In the API Setup page, add your own WhatsApp number as a recipient and confirm the code WhatsApp sends you.
4. In Apps Script, add these script properties:
   - `WA_TOKEN`: the access token
   - `WA_PHONE_ID`: the Phone number ID
   - `WA_TO`: your number with the country code and no `+` or spaces (for example `97339123456`)
5. Run `sendDueReminders` once to test.

Check Meta's current pricing before you use WhatsApp for every day: test numbers are free to try, and live messages are billed by Meta.

**Limits**
- A PC or phone receives a notification only while its browser or phone is on and notifications are allowed.
- Email and WhatsApp reach you even when your devices are off, but only if Apps Script runs and the message is delivered.
- The reminder uses the data from the app's last sync, so sync after you change payments.
- Reminders help you remember. They do not pay anything for you.
