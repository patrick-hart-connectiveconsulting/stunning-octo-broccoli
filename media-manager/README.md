# Media Manager: Run and Test on Your Computer

This guide tells you how to start Media Manager on your computer. It also tells you how to test it.

Media Manager is a small content server. It has two parts:

- **Media Library**: you upload, organize and download files.
- **Streams**: you make data streams (events, posts, products) and use them through a REST API.

For a full description of all functions and API endpoints, see [SPEC.md](SPEC.md).

**Contents**

1. [Requirements](#1-requirements)
2. [Get the code](#2-get-the-code)
3. [Start the server](#3-start-the-server)
4. [Open the admin pages](#4-open-the-admin-pages)
5. [Do the automated tests](#5-do-the-automated-tests)
6. [Do a manual test in the browser](#6-do-a-manual-test-in-the-browser)
7. [Do a manual test of the API](#7-do-a-manual-test-of-the-api)
8. [Test the webhooks](#8-test-the-webhooks)
9. [Test the standard formats](#9-test-the-standard-formats)
10. [Remove the test data](#10-remove-the-test-data)
11. [Configuration](#11-configuration)
12. [Troubleshooting](#12-troubleshooting)
13. [Files and folders](#13-files-and-folders)

---

## 1. Requirements

| Item | Requirement |
| --- | --- |
| Node.js | Version 22 (LTS) is recommended. Version 20 is the minimum (see the note below). |
| npm | The version that comes with Node.js |
| Operating system | macOS, Linux or Windows |
| Terminal | Sections 1–6, 9 and 10: any terminal (Terminal on macOS, a Linux shell, PowerShell or Command Prompt on Windows). Step 6.7 and sections 7–8: `bash` or `zsh`. On Windows, use Git Bash or WSL for these steps. |
| Browser | A current version of Chrome, Edge, Firefox or Safari |
| `curl` | Necessary for sections 7 and 8 only. macOS, Linux, Git Bash and Windows 10 or later include `curl`. |

You do not need a database. You do not need Docker. Media Manager has **no npm dependencies**, so you do not need `npm install`.

To see your Node.js version, enter this command:

```bash
node --version
```

The result must be `v20.0.0` or higher. If your version is lower, install Node.js 22 from <https://nodejs.org>.

> **NOTE:** With Node.js 20 on Windows, the `npm test` command does not find the test files. Use Node.js 22 on Windows.

---

## 2. Get the code

Media Manager is in the `media-manager` folder of this repository. The other folders contain a different application (Strapi). You do not need them for Media Manager.

1. Clone the repository:

   ```bash
   git clone https://github.com/patrick-hart-connectiveconsulting/stunning-octo-broccoli.git
   ```

2. Go to the Media Manager folder:

   ```bash
   cd stunning-octo-broccoli/media-manager
   ```

All commands in this guide start in the `media-manager` folder.

---

## 3. Start the server

### 3.1 Start with an API token (recommended)

The API token protects all changes to the data. Use a token, also on your own computer. Then the server operates the same as in production.

1. Open a terminal.
2. Go to the `media-manager` folder (section 2, step 2).
3. Enter this command. It operates in all terminals, also in PowerShell and Command Prompt:

   ```bash
   npm run start:local
   ```

   This command starts the server with the token `dev-token`.

4. Make sure that the terminal shows these lines:

   ```
   Media manager running at http://localhost:1338
   API token required for write operations.
   ```

5. Keep this terminal open. The server stops when you close the terminal.

This guide uses `dev-token` in all examples.

#### Use a different token

To use a different token, give it with the `--token` option. Type `--` before the option:

```bash
npm start -- --token=my-secret-token
```

You can also set the token in the environment variable `MEDIA_API_TOKEN`. The command is different for each terminal:

| Terminal | Command |
| --- | --- |
| macOS, Linux, Git Bash, WSL | `MEDIA_API_TOKEN=dev-token npm start` |
| Windows PowerShell | `$env:MEDIA_API_TOKEN="dev-token"; npm start` |
| Windows Command Prompt | `set MEDIA_API_TOKEN=dev-token` and then `npm start` (two commands) |

> **NOTE:** In PowerShell and Command Prompt, the variable stays set until you close the terminal.

### 3.2 Start without an API token

To start the server without a token, enter this command:

```bash
npm start
```

The terminal shows a warning: `MEDIA_API_TOKEN not set — write API is open.`

> **WARNING:** Do not use this mode on a shared network. Without a token, all persons on the network can change and delete all data.

### 3.3 Start in development mode

In development mode, the server starts again automatically when you change a file in `src/`:

```bash
npm run dev:local
```

> **NOTE:** When you change a file in `public/`, you do not have to start the server again. Refresh the page in the browser.

### 3.4 Stop the server

Push **Ctrl+C** in the terminal that shows the server output.

### 3.5 Make sure that the server operates

Open this address in the browser: <http://localhost:1338/api/health>

The page must show `{"ok":true}`.

---

## 4. Open the admin pages

| Page | Address | Use |
| --- | --- | --- |
| Media Library | <http://localhost:1338/> | Upload and manage files |
| Streams | <http://localhost:1338/streams.html> | Make streams, edit items, manage settings |

Give the token to the admin pages before you make changes:

1. Open <http://localhost:1338/>.
2. At the bottom of the left menu, click **Set API token**. On a narrow screen, this control is a key symbol at the top of the page.
3. Type `dev-token` and click **OK**.
4. Make sure that the control now shows **API token set**.

The browser keeps the token. The two admin pages use the same token. To change the token, click **API token set** again.

> **NOTE:** If you started the server without a token (step 3.2), the **Set API token** control does not show. You can make changes immediately.

---

## 5. Do the automated tests

The automated tests examine the full API. They do not use your data in `data/`. Each test file makes its own temporary data folder and starts its own server on a free port. You can do the tests while your server operates.

### 5.1 Do all tests

```bash
npm test
```

The tests take approximately 3 seconds. Make sure that the last lines show `fail 0`:

```
# tests 34
# pass 34
# fail 0
```

### 5.2 Do the tests of one file

```bash
node --test test/streams.test.js
```

| Test file | Tests |
| --- | --- |
| `test/api.test.js` | Media Library: upload, folders, file replacement, size limits, security headers |
| `test/streams.test.js` | Streams and items: create, filter, sort, pages, live feed, data after a restart |
| `test/content.test.js` | Templates, draft and publish, field types, unique values, retention, webhooks |
| `test/relations-keys-schedule.test.js` | Relations, API keys, scheduled publish and unpublish |
| `test/formats-geo-cors.test.js` | CORS, map pins, dates, media in `populate`, calendar, RSS, JSON, GeoJSON and CSV formats |

> **CAUTION:** Do not use `--test-name-pattern` to do only one test in a file. The tests in a file use the data from the tests before them. A single test can fail when it starts without that data. Always do a full file.

### 5.3 If a test fails

1. Find the lines that start with `not ok`. They give the name of the test that failed.
2. Read the `expected` and `actual` values below that line.
3. Do the tests of that file again (step 5.2).
4. If the test fails again, do the checks in [section 12](#12-troubleshooting).

---

## 6. Do a manual test in the browser

Do these steps in the given sequence. Before you start, do these two steps:

- Start the server with a token (step 3.1).
- Give the token to the admin pages (section 4).

### 6.1 Media Library

1. Open <http://localhost:1338/>.
2. Click **Add new folder**. Type `Images` and click **Save**.
3. Click **Add new assets**. Select two or three images from your computer.
4. Click **Upload assets**.
5. Make sure that the images show in the grid with their dimensions.
6. Click an image. Type a value in **Alternative text**. Set **Location** to `Images`. Click **Finish**.
7. Open the **Images** folder. Make sure that the image is in the folder.

### 6.2 Streams with a template

1. Open <http://localhost:1338/streams.html>.
2. Click **Create new stream**.
3. Click the **Blog posts** template. The form shows eight fields.
4. Click **Create stream**. The page shows the **API** tab of the new stream.
5. Click the **Posts** tab. Then click **New post**.
6. Type a value in **title** and in **body**. Do not type a value in **slug**.
7. Click **Save draft**. The table shows the post with the status **Draft**. The server made the slug from the title.
8. Click the post in the table. Click **Save & publish**. The status changes to **Published**.

### 6.3 Validation

1. Click **New post**. Type a value in **title** only.
2. Click **Publish**. A red message shows: `Validation failed: data.body is required`.
3. Click **Save draft**. The post is saved. A draft can be incomplete.

### 6.4 Relations

1. Click **Create new stream**. Select **Blank**. Type `Authors` as the name.
2. Click **+ Add field**. Type `name` as the field name. Select **Required**.
3. Click **Create stream**.
4. Click the **Items** tab. Click **New item**. Type a name and click **Create item**.
5. Click the **Blog posts** stream in the list on the left. Click the **Dataset** tab.
6. Click **+ Add field**. Type `writer`. Select the type **Relation**. In the next list, select **Authors**.
7. Click **Save dataset**.
8. Click the **Posts** tab. Click a post. In **writer**, select the author. Click **Save**.

### 6.5 Scheduled publish

1. Click **New post**. Type a **title** and a **body**.
2. In **Publish at**, set a time that is two minutes from now.
3. Make sure that the button **Save draft** changed to **Schedule**. Click **Schedule**.
4. Make sure that the status shows **Scheduled** and the time.
5. Wait until the time has passed. Keep the page open.
6. Make sure that the status changes to **Published**. This can occur up to 15 seconds after the time. You do not have to refresh the page.

### 6.6 API keys

1. Click the **Settings** tab.
2. In **API keys**, type `Laptop test` as the name.
3. Make sure that only **Create** is selected.
4. Click **Create key**. A yellow box shows the key.
5. Click **Copy**. Keep the key for section 7.

> **CAUTION:** Copy the key immediately. The server shows the key one time only. If you lose the key, revoke it and make a new key.

### 6.7 Live updates

1. Click the **Posts** tab. Make sure that **Live** is selected and that the dot is green.
2. In a `bash` or `zsh` terminal (on Windows: Git Bash or WSL), make a post with the API:

   ```bash
   curl -X POST http://localhost:1338/api/streams/blog-posts/items \
     -H "Authorization: Bearer dev-token" -H "Content-Type: application/json" \
     -d '{"data":{"title":"Live test","body":"Text"},"publish":true}'
   ```

3. Make sure that the post **Live test** shows in the table. You do not have to refresh the page.

---

## 7. Do a manual test of the API

Start the server with a token (step 3.1). Use a second terminal for these commands. Use `bash` or `zsh` (on Windows: Git Bash or WSL).

1. Set two shell variables. The commands that follow use them:

   ```bash
   export MEDIA_API_TOKEN=dev-token
   export BASE=http://localhost:1338
   ```

2. Make a stream from the **Blog posts** template:

   ```bash
   curl -X POST "$BASE/api/streams" \
     -H "Authorization: Bearer $MEDIA_API_TOKEN" -H "Content-Type: application/json" \
     -d '{"name":"Blog","template":"blog-posts"}'
   ```

   The response contains `"slug":"blog"`. If the stream `blog` exists already, the response is a `409` error. You can ignore this error.

3. Make a published post:

   ```bash
   curl -X POST "$BASE/api/streams/blog/items" \
     -H "Authorization: Bearer $MEDIA_API_TOKEN" -H "Content-Type: application/json" \
     -d '{"data":{"title":"Hello World","body":"# Hi","tags":["news"]},"publish":true}'
   ```

   The response contains `"slug":"hello-world"`. The server made the slug from the title.

4. Read the post without a token, as a public visitor:

   ```bash
   curl -g "$BASE/api/streams/blog/items?filter[slug]=hello-world"
   ```

   > **NOTE:** Use the `-g` option when the address contains `[` or `]`. Without `-g`, `curl` changes these characters and shows `bad range in URL`.

5. Make a draft:

   ```bash
   curl -X POST "$BASE/api/streams/blog/items" \
     -H "Authorization: Bearer $MEDIA_API_TOKEN" -H "Content-Type: application/json" \
     -d '{"data":{"title":"Draft post"}}'
   ```

   Copy the value of `"id"` from the response. Put it in a variable:

   ```bash
   export DRAFT_ID=<paste the id here>
   ```

6. Make sure that a public visitor cannot see the draft:

   ```bash
   curl "$BASE/api/streams/blog/items"
   ```

   The result shows `"total":1`. The draft is not in the list.

7. Read all posts with the token:

   ```bash
   curl "$BASE/api/streams/blog/items?status=all" -H "Authorization: Bearer $MEDIA_API_TOKEN"
   ```

   The result shows `"total":2`.

8. Start the live feed in a third terminal. Keep this terminal open:

   ```bash
   curl -N http://localhost:1338/api/streams/blog/subscribe
   ```

9. In the second terminal, add the missing body to the draft. Then schedule the draft for one minute from now:

   ```bash
   curl -X PATCH "$BASE/api/streams/blog/items/$DRAFT_ID" \
     -H "Authorization: Bearer $MEDIA_API_TOKEN" -H "Content-Type: application/json" \
     -d '{"data":{"body":"Some text"}}'

   WHEN=$(node -e "console.log(new Date(Date.now() + 60000).toISOString())")

   curl -X PATCH "$BASE/api/streams/blog/items/$DRAFT_ID" \
     -H "Authorization: Bearer $MEDIA_API_TOKEN" -H "Content-Type: application/json" \
     -d "{\"publishAt\":\"$WHEN\"}"
   ```

   The response contains the time in `"publishAt"`.

10. Wait approximately 75 seconds. The third terminal shows `event: created`. For a public visitor, the post is new at this time.

11. Test an API key. Use the key from step 6.6, or make a new key:

    ```bash
    curl -X POST "$BASE/api/streams/blog/keys" \
      -H "Authorization: Bearer $MEDIA_API_TOKEN" -H "Content-Type: application/json" \
      -d '{"name":"Laptop test","scopes":["create"]}'
    ```

    Copy the value of `"key"`. It starts with `mmk_`. Put it in a variable:

    ```bash
    export KEY=<paste the key here>
    ```

    > **NOTE:** A key operates on one stream only. A key from step 6.6 operates on the `blog-posts` stream. For the commands below, use a key for the `blog` stream.

12. Make sure that the key can make items:

    ```bash
    curl -X POST "$BASE/api/streams/blog/items" \
      -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
      -d '{"data":{"title":"From a key"}}'
    ```

    The response is the new item.

13. Make sure that the key cannot delete items:

    ```bash
    curl -X DELETE "$BASE/api/streams/blog/items/$DRAFT_ID" -H "Authorization: Bearer $KEY"
    ```

    The response is a `403` error: `This API key does not have the "delete" scope`.

14. To stop the live feed, push **Ctrl+C** in the third terminal.

For more API examples, open a stream in the admin page and click the **API** tab. For all endpoints, see [SPEC.md](SPEC.md).

---

## 8. Test the webhooks

A webhook sends each change to a different server. On your computer, you can use a small receiver to see the requests.

1. Start a receiver in a new terminal. Keep this terminal open:

   ```bash
   node -e "require('http').createServer((req,res)=>{let b='';req.on('data',c=>b+=c);req.on('end',()=>{console.log(req.headers['x-webhook-event'],b.slice(0,120));res.end()})}).listen(4000,()=>console.log('Webhook receiver on http://localhost:4000'))"
   ```

2. Open <http://localhost:1338/streams.html>. Click the **Blog** stream.
3. Click the **Settings** tab. Click **+ Add webhook**.
4. Type `http://localhost:4000/hook` as the URL. Click **Save settings**.
5. Click **Send test**. A green message shows: `Test delivered (HTTP 200)`.
6. Make sure that the receiver terminal shows a line that starts with `ping`.
7. Make a post on the **Posts** tab. Make sure that the receiver terminal shows a line that starts with `item.created`.

To stop the receiver, push **Ctrl+C** in its terminal.

---

## 9. Test the standard formats

Each stream also gives its published items in standard formats. Do this test after section 7. Open these addresses in the browser:

| Address | Result |
| --- | --- |
| <http://localhost:1338/api/streams/blog/feed.rss> | An RSS feed |
| <http://localhost:1338/api/streams/blog/feed.json> | A JSON Feed |
| <http://localhost:1338/api/streams/blog/items.csv> | The browser downloads `blog.csv` |

To test a calendar feed and map pins:

1. Make a stream from the **Events** template (section 6.2, step 3).
2. Make an event. Set **start**. In the field below **location**, paste a Google Maps link. The latitude and longitude change.
3. Click **Publish**.
4. Open <http://localhost:1338/api/streams/events/feed.ics>. The browser downloads a calendar file. Open the file in your calendar application.
5. Open <http://localhost:1338/api/streams/events/feed.geojson>. The result shows a `Point` for each event.

> **NOTE:** A calendar application on a different computer cannot read `localhost`. To subscribe from a phone, the server must be available on the network.

---

## 10. Remove the test data

All data is in the `data/` folder:

- the stream definitions
- the items
- the uploaded files
- the API keys and the webhook settings

Git ignores this folder.

1. Stop the server (step 3.4).
2. Delete the `data` folder in the `media-manager` folder. You can use the file manager, or one of these commands:

   | Terminal | Command |
   | --- | --- |
   | macOS, Linux, Git Bash, WSL | `rm -rf data` |
   | Windows PowerShell | `Remove-Item -Recurse -Force data` |
   | Windows Command Prompt | `rmdir /s /q data` |

3. Start the server again (step 3.1). The server makes a new, empty `data/` folder.

> **NOTE:** The browser keeps the token after you remove the data. If you start the server with a different token, click **API token set** and type the new token.

---

## 11. Configuration

You can set these values as environment variables (see the table in step 3.1). For `token`, `port` and `host`, you can also use an option after `npm start --`. An option has priority over the environment variable.

| Environment variable | Option | Default | Function |
| --- | --- | --- | --- |
| `PORT` | `--port=` | `1338` | The port of the server |
| `HOST` | `--host=` | `0.0.0.0` | The network address of the server. Use `127.0.0.1` to accept connections from your computer only. |
| `MEDIA_API_TOKEN` | `--token=` | *(not set)* | The main API token. If you do not set it, all users can make changes. |
| `MEDIA_DATA_DIR` | — | `media-manager/data` | The folder for the data |
| `MEDIA_MAX_FILE_SIZE` | — | `52428800` (50 MB) | The maximum size of an uploaded file, in bytes |
| `MEDIA_CORS_ORIGINS` | `--cors=` | *(not set)* | The websites that can use the API from a browser. Use a comma-separated list such as `https://www.example.com,http://localhost:5173`, or `*` for all websites. |
| `MEDIA_PUBLIC_URL` | `--public-url=` | *(the address in the request)* | The public address of the server, for links in feeds. Example: `https://cms.example.com`. |
| `MEDIA_TIMEZONE` | — | `UTC` | The time zone for all-day events in calendar feeds. Example: `Europe/London`. |

Example with options (all terminals):

```bash
npm start -- --token=dev-token --port=4100 --host=127.0.0.1
```

Example with environment variables (`bash` or `zsh`):

```bash
PORT=4100 HOST=127.0.0.1 MEDIA_API_TOKEN=dev-token MEDIA_DATA_DIR=/tmp/mm-data MEDIA_MAX_FILE_SIZE=10485760 npm start
```

> **NOTE:** The default port is `1338`. The Strapi application in this repository uses port `1337`. You can operate the two applications at the same time.

---

## 12. Troubleshooting

| Problem | Cause | Action |
| --- | --- | --- |
| A website on a different address gets `blocked by CORS policy` in the browser console | The server does not allow that website. | Start the server with the address of the website: `npm start -- --token=dev-token --cors=http://localhost:5173`. |
| PowerShell shows `The term 'MEDIA_API_TOKEN=dev-token' is not recognized`, or Command Prompt shows `'MEDIA_API_TOKEN' is not recognized as an internal or external command` | The `NAME=value command` form operates in `bash` and `zsh` only. | Use `npm run start:local` (step 3.1). Or use the command for your terminal from the table in step 3.1. |
| The terminal shows `Could not read package.json` | The terminal is not in the `media-manager` folder. | Go to the folder: `cd stunning-octo-broccoli/media-manager`. Then enter the command again. |
| `Port 1338 is already in use` | A different program uses port 1338. This can be a second Media Manager server. | Stop the other program. Or start with a different port: `npm start -- --token=dev-token --port=1339`. |
| On Windows, `npm test` does not find the test files | You use Node.js 20. | Install Node.js 22. Or do each test file with `node --test test/<file>`. |
| An error such as `fetch is not defined` when you start the server or do the tests | Your Node.js version is too old. | Install Node.js 22 (section 1). |
| The API returns `401` and "Missing or invalid API token" | The request has no token, or the token is incorrect. | Add `-H "Authorization: Bearer dev-token"`. Make sure that the value is the same as `MEDIA_API_TOKEN`. |
| The API returns `403` | The API key does not have the necessary scope. | Use a key with the correct scope, or use the main token. |
| The admin page shows "Missing or invalid API token" after each change | The browser has an incorrect token. | Click **API token set** and type the correct token. |
| A scheduled post does not go live | The server was stopped, or the post was not valid at the scheduled time. | Make sure that the server operates. Open the post. A red message at the top of the form gives the cause. |
| The **Live** dot is red | The server stopped, or the connection failed. | Start the server. The page connects again automatically after 3 seconds. |
| `curl` shows `bad range in URL` | The address contains `[` or `]`. | Add the `-g` option. |
| On Windows, the `curl` examples fail | PowerShell and `cmd.exe` use different quotation rules. | Use Git Bash or WSL for the examples. |

---

## 13. Files and folders

```
media-manager/
├── README.md            This guide
├── SPEC.md              The full specification of the functions and the API
├── package.json         The npm scripts (start, dev, test). There are no dependencies.
├── src/                 The server
│   ├── server.js        The HTTP server, the Media Library API, the static files
│   ├── streams.js       The Streams API: items, publish, schedules, relations, keys
│   ├── schema.js        The field types and the validation
│   ├── templates.js     The stream templates
│   ├── formats.js       The calendar, RSS, JSON Feed, GeoJSON and CSV outputs
│   ├── webhooks.js      The webhook deliveries and signatures
│   ├── event-log.js     The storage of items (one file for each stream)
│   ├── store.js         The storage of files, folders and stream definitions
│   ├── http.js          Shared HTTP functions
│   ├── image-size.js    Reads the dimensions of images
│   └── mime.js          File types
├── public/              The admin pages (HTML, CSS and JavaScript, no build step)
├── test/                The automated tests (node:test)
└── data/                Your local data. The server makes this folder. Git ignores it.
```
