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

## 3. Payment reminders by Gmail

Google does not let an app run on a schedule, so reminders are sent by a small Google script in your own account:

1. Open **script.google.com**, click **New project**, delete the sample code and paste the contents of `dues-reminder.gs`.
2. Click **Project Settings** (gear icon) and set **Time zone** to *Asia/Bahrain*.
3. Choose the function `setupDailyReminder` from the top bar, click **Run**, and approve the permissions it asks for.
4. Every morning at about 8am you will get an email if anything is due within 3 days or overdue. Gmail on your phone shows it as a notification.

The script reads the small file `dues.json` that the app writes to a visible **DSi Wallet** folder in your Drive after each sync. Open the app and sync at least once after you set this up.

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
