# Google OAuth Setup

This guide walks you through creating Google OAuth credentials for Clawvisor.
Once configured, you can activate Gmail, Calendar, Drive, and Contacts from the
Clawvisor dashboard — all four share a single OAuth connection.

## 1. Create a Google Cloud project

1. Go to the [Google Cloud Console](https://console.cloud.google.com/)
2. Click the project dropdown at the top and select **New Project**
3. Name it something like `Clawvisor` and click **Create**
4. Make sure the new project is selected in the dropdown

## 2. Enable the APIs

Go to **APIs & Services → Library** and enable each of these:

- [Gmail API](https://console.cloud.google.com/apis/library/gmail.googleapis.com)
- [Google Calendar API](https://console.cloud.google.com/apis/library/calendar-json.googleapis.com)
- [Google Drive API](https://console.cloud.google.com/apis/library/drive.googleapis.com)
- [People API](https://console.cloud.google.com/apis/library/people.googleapis.com) (for Contacts)

You only need to enable the ones you plan to use, but there's no harm in
enabling all four.

## 3. Configure the OAuth consent screen

1. Go to **APIs & Services → OAuth consent screen**
2. Select **External** (unless you have a Google Workspace org and want internal-only)
3. Fill in the required fields:
   - **App name:** `Clawvisor`
   - **User support email:** your email
   - **Developer contact:** your email
4. Click **Save and Continue**
5. On the **Scopes** page, click **Add or Remove Scopes** and add:
   - `https://www.googleapis.com/auth/gmail.readonly`
   - `https://www.googleapis.com/auth/gmail.send`
   - `https://www.googleapis.com/auth/calendar.readonly`
   - `https://www.googleapis.com/auth/calendar.events`
   - `https://www.googleapis.com/auth/drive.readonly`
   - `https://www.googleapis.com/auth/drive.file`
   - `https://www.googleapis.com/auth/contacts.readonly`
6. Click **Save and Continue** through the remaining steps

> **Note:** While in "Testing" status, only test users you explicitly add can
> authorize. Add your own Google account under **Test users** on the consent
> screen page.

## 4. Create OAuth credentials

1. Go to **APIs & Services → Credentials**
2. Click **Create Credentials → OAuth client ID**
3. Application type: **Web application**
4. Name: `Clawvisor`
5. Under **Authorized redirect URIs**, add:
   - `http://localhost:8080/api/oauth/google/callback` (for local development)
   - If you're running Clawvisor on a different host/port, adjust accordingly
     (e.g. `https://clawvisor.yourdomain.com/api/oauth/google/callback`)
6. Click **Create**
7. Copy the **Client ID** and **Client Secret**

## 5. Configure Clawvisor

Set the credentials as environment variables before starting the server:

```bash
export GOOGLE_CLIENT_ID="your-client-id.apps.googleusercontent.com"
export GOOGLE_CLIENT_SECRET="your-client-secret"
```

Or add them to your `config.yaml`:

```yaml
services:
  google:
    client_id: "your-client-id.apps.googleusercontent.com"
    client_secret: "your-client-secret"
```

If you ran `make setup` and said **Yes** to Google services, the setup wizard
prompted you for these values and wrote them to `config.yaml` already.

## 6. Connect your account

1. Start Clawvisor: `make run`
2. Open the dashboard and go to **Services**
3. Click **Connect** next to Google
4. You'll be redirected to Google's consent screen — authorize with your account
5. Once connected, Gmail, Calendar, Drive, and Contacts will show as active

## Troubleshooting

**"Access blocked: This app's request is invalid" (redirect_uri_mismatch)**

The redirect URI in your OAuth credentials doesn't match what Clawvisor is
using. Check that:
- The URI in Google Cloud matches your Clawvisor URL exactly
- You're using `http` (not `https`) for localhost
- The path is `/api/oauth/google/callback`

**"This app isn't verified"**

This is normal for apps in "Testing" status. Click **Continue** (you may need
to click "Advanced" first). You can submit for verification later if you want
to support multiple users.

**"Error 403: access_not_configured"**

You haven't enabled the API you're trying to use. Go back to step 2 and enable
the relevant API in the Google Cloud Console.

**Only some services work**

Each API must be enabled individually. If Gmail works but Calendar doesn't,
check that the Calendar API is enabled in your project.
