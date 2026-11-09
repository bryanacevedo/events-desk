# Google setup, for someone doing it the first time

Events Desk can put each delivered list on a Google Sheet and read the Review tab back. There are two ways to sign in. Pick one.

| | Personal Gmail (OAuth) | Company Workspace (service account) |
|---|---|---|
| Who owns the Sheets | You, in your own Drive | A robot account, in a Shared Drive |
| Needs a Workspace domain | No | Yes, and a Shared Drive |
| Who can open a Sheet | You, plus the addresses you list as editors | Everyone at your domain, as editors |

This page is the click-by-click for the **personal Gmail** path. The service account path is at the end.

Nothing in this setup costs money. Google's screens move around from time to time; if a label below is slightly different, look for the closest one.

## A. Personal Gmail (OAuth)

You do this once, signed in as the Google account that should own the Sheets.

### 1. Make a Google Cloud project

1. Go to https://console.cloud.google.com and sign in.
2. If Google asks you to agree to terms, tick the box and continue.
3. At the top left, click the project name (next to the "Google Cloud" logo), then **New project**.
4. Project name: `Events Desk`. Leave Organization as "No organization". Click **Create**.
5. Wait for the bell icon to say the project is ready, then pick **Events Desk** in the project list at the top left. Make sure its name now shows at the top.

### 2. Turn on the two APIs

1. Open the left menu (three lines), then **APIs & Services**, then **Library**.
2. Search `Google Drive API`. Click it, then **Enable**.
3. Go back to **Library**. Search `Google Sheets API`. Click it, then **Enable**.

### 3. Set up the consent screen

1. Left menu, **APIs & Services**, then **OAuth consent screen**. (Newer accounts show **Google Auth Platform** here. Click **Get started**.)
2. App name: `Events Desk`. User support email: your address. Click **Next**.
3. Audience: choose **External**. Click **Next**.
4. Contact email: your address. Click **Next**, tick the agreement box, click **Continue**, then **Create**.
5. Open **Data Access** (older screen: **Edit app**, then the **Scopes** step). Click **Add or remove scopes**.
6. In the filter box type `drive.file`. Tick the row ending in `.../auth/drive.file` ("See, edit, create and delete only the specific Google Drive files you use with this app"). Click **Update**, then **Save**.
   This is the narrowest Drive permission there is. Events Desk can only touch files it created itself. It cannot see the rest of your Drive.
7. Open **Audience** (older screen: **OAuth consent screen**, then **Publishing status**). Click **Publish app**, then **Confirm**. The status must say **In production**.
   Do not skip this. While the app says "Testing", Google expires the sign-in after 7 days and delivery quietly stops working. Because `drive.file` is not a sensitive scope, going to production needs no review.

### 4. Make the sign-in key

1. Left menu, **APIs & Services**, then **Credentials** (newer: **Google Auth Platform**, then **Clients**).
2. **Create credentials**, then **OAuth client ID** (newer: **Create client**).
3. Application type: **Desktop app**. Name: `Events Desk desktop`. Click **Create**.
4. A box shows a **Client ID** and a **Client secret**. Copy both into the `.env` file in the project folder (copy `.env.example` to `.env` first if you have not):

   ```
   GOOGLE_OAUTH_CLIENT_ID=the long id ending in apps.googleusercontent.com
   GOOGLE_OAUTH_CLIENT_SECRET=the shorter secret
   ```

   Treat the secret like a password. `.env` is not committed.

### 5. Sign in once

1. In a terminal, in the project folder, run (the file name is yours to choose, and it must not exist yet):

   ```
   make google-auth OUT=$HOME/events-desk-google-token
   ```

2. It prints a long link starting with `https://accounts.google.com`. Copy it into your browser.
3. Choose the Google account that should own the Sheets.
4. You will see **Google hasn't verified this app**. That is expected: you are the developer of this app. Click **Advanced**, then **Go to Events Desk (unsafe)**.
5. Tick the box for **See, edit, create and delete only the specific Google Drive files you use with this app**, then **Continue**.
6. The browser says "Done. You can close this tab". Go back to the terminal. It says it saved the token to your file. **It does not print the token.**
7. Put the token in `.env` without displaying it. On a Mac:

   ```
   printf 'GOOGLE_OAUTH_REFRESH_TOKEN=%s\n' "$(cat $HOME/events-desk-google-token)" >> .env
   rm $HOME/events-desk-google-token
   ```

### 6. Say who gets edit access

In `.env`:

```
GOOGLE_SHARE_EMAILS=teammate@gmail.com,another@gmail.com
```

Each address gets the Sheet as an **editor**, and Google emails them the link. Leave the line empty or out and every Sheet stays private to you. Events Desk never uses "anyone with the link" for event data, because the file holds personal contact data.

### 7. Check it works

Run:

```
make publish-sample
```

It uploads the fictional sample workbook as a Google Sheet called `Events Desk sample (fictional data)` and prints the link. Open it. Run it again and the same link updates in place.

To let anyone with the link view the sample (it is fictional), run `make publish-sample ARGS=--public-view`. That option exists only for the sample. It cannot be used on a real event.

### 8. Turn it on for real events

Set `LIVE_SPEND=1` with the other live settings (see the README) and start the server. When an event reaches **delivered**, the Sheet is created and its link appears on the event. If Google fails, the event is still delivered, the reason is recorded, and the file download still works. After the file is created, a second pass through the Sheets API sets fonts, tab colors, dropdown chips and saved filter views. If that pass is refused, the Sheet and its link still stand. When new registrations are merged into a delivered event, the same Sheet is rebuilt in place and keeps what people typed in Review, Outreach status, Notes and Meetings.

### If something goes wrong

| What you see | What it means |
|---|---|
| `Google sign-in failed (400): invalid_grant` | The token was revoked or expired. If the consent screen still says Testing, publish it (step 3.7). Then run step 5 again. |
| `Google answered 403 ... API has not been used` | One of the two APIs is not enabled in this project (step 2). |
| `Google answered 403 ... insufficient` or `404` when reading a Sheet back | The Sheet was not made by this app's sign-in. `drive.file` only sees files this app created. |
| `Google returned no refresh token` | You signed in before. Go to https://myaccount.google.com/permissions, remove Events Desk, and run step 5 again. |
| `Access blocked` on the consent page | The client type is not Desktop app, or your address is not allowed. Redo step 4. |

To cut off access completely: https://myaccount.google.com/permissions, then Events Desk, then **Delete all connections**. Deleting the Google Cloud project also works.

## B. Company Workspace (service account)

Needs a Google Workspace domain and a Shared Drive, because a robot account cannot own files in someone's My Drive.

1. Do steps A1 and A2 (project and the two APIs).
2. **IAM & Admin**, then **Service accounts**, then **Create service account**. Name `events-desk`. Skip the optional steps, click **Done**.
3. Click the account, open **Keys**, **Add key**, **Create new key**, **JSON**, **Create**. A file downloads. Put its entire contents on one line in `GOOGLE_SERVICE_ACCOUNT_JSON`.
4. In Google Drive create a **Shared Drive**. Open **Manage members** and add the service account's email (it ends in `iam.gserviceaccount.com`) as **Content manager**.
5. Make a folder in that Shared Drive. Open it and copy the last part of the address bar (after `folders/`) into `GOOGLE_DRIVE_FOLDER_ID`.
6. Set `GOOGLE_SHARE_DOMAIN` to your domain, for example `example.com`. Each Sheet is shared with that domain as editors.
7. Your Workspace admin and the Shared Drive must both allow sharing with the domain, or delivery records an error and the download still works.

Set either the service account variables or the `GOOGLE_OAUTH_` variables, not both. The server refuses to start with both.
