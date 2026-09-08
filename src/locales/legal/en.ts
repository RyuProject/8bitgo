import type { LegalDocCopy } from './types'

/**
 * Terms of Service / Privacy Policy — English.
 *
 * Shared by en, es, fr, it, de and ja (same pattern as `aboutEnglish` in
 * src/locales/about.ts). Machine-translating legal text into five more languages
 * without anyone to proof it is worse than showing a language a reader can
 * actually verify — and clause 18 / the closing note both say the Simplified
 * Chinese version prevails, so an unproofed translation would also be the
 * non-authoritative one.
 *
 * ⚠️ Two hard rules, same as the Chinese file:
 *
 * 1. **Body text starts at column 0.** renderMarkdown detects lists with
 *    /^[-*]\s+/ anchored at line start; block.trim() only trims the ends of a
 *    whole block, not each line. One leading space collapses a list into a
 *    paragraph full of <br>.
 * 2. **No in-site Markdown links.** renderMarkdown emits a plain <a href>, which
 *    bypasses react-router — and the language prefix IS the router basename, so
 *    href="/privacy" inside /ja/terms lands on the Simplified Chinese page.
 *    Refer to the other document by name. mailto: is fine.
 *
 * ⚠️ Section ids must stay identical to the Chinese file — the anchors are
 *    quoted externally and scripts/test-legal-pages.mjs compares the id sets.
 */

const CONTACT = 'yeahcore@yeah.net'
const UPDATED = '2026-09-07'

export const termsEnglish: LegalDocCopy = {
  seoTitle: 'Terms of Service',
  seoDescription:
    'The 8BitGo terms of service: eligibility, accounts, game files and the copyright takedown process, live streaming, cloud saves, disclaimers and governing law.',
  h1: 'Terms of Service',
  updatedLabel: 'Last updated',
  updated: UPDATED,
  tocLabel: 'Contents',
  intro: `Welcome to 8BitGo. These terms set out what you and we each owe the other when you use this site.

8BitGo is **run by one independent developer as an individual**. There is no company and no support team — the terms are written plainly so you can actually finish reading them before you sign up, rather than having the obligations buried in long sentences.

**By opening and using 8BitGo you confirm that you have read and accept these terms.** If there is any clause you do not accept, please do not use the site.`,
  sections: [
    {
      id: 'operator',
      title: 'Who runs this site, and how to reach them',
      body: `8BitGo (this site, at 8bitgo.com) was created, is developed and is operated by one independent developer acting as an individual. There is no company, no investor and no team.

Everything — account problems, copyright complaints, data requests — goes to one address:

- Email: [${CONTACT}](mailto:${CONTACT})

One person reads all of it, so replies are not immediate. Copyright takedowns and account-security mail are handled first.`,
    },
    {
      id: 'eligibility',
      title: 'Who may use the site',
      body: `### Age

- **You must be at least 13 to use this site**, including browsing and trying games.
- Between 13 and the age of majority where you live, use the site only with the knowledge and consent of a parent or guardian.
- Games marked **adult-rated** have an additional requirement: you must be signed in, and the date of birth on your account must show that you are 18 or older. That check runs on the server and cannot be bypassed from the browser.

### Where you are

The site is reachable worldwide, but we do not warrant that it complies with every law of your country or region. **Deciding whether using this site is lawful where you are is your responsibility.** If local law prohibits access to content offered here, do not access it.

### One account per person

You should not create multiple accounts to evade a ban or manipulate ratings.`,
    },
    {
      id: 'account',
      title: 'Accounts',
      body: `### How to create one

You can register with an email address and password, sign in with an emailed code, or sign in with a Google, Microsoft or Apple account.

**Accounts are merged on the verified email address.** If you register with an email and later sign in with a Google account on that same address, you land in the same account — this is deliberate, so that one person does not end up with several sets of saves that cannot see each other.

### What is on you

- Keep your password and your sign-in mailbox secure. Anything done through your account is treated as done by you.
- Give a truthful date of birth. **It can only be entered once** and you cannot change it afterwards (it is write-once by design). If you got it wrong, email us and the operator will clear it so you can re-enter it.
- Do not lend your account to anyone, and do not buy or sell accounts.

### What we may do

If an account is used for anything the "House rules" clause prohibits, we may restrict features, suspend or delete it without prior notice. Clearly unlawful content leads to an immediate ban.

### Closing your account

You can close it yourself: start the deletion from your profile, we email a code to the address on the account, and once it is verified the account is deleted together with your favourites, recently played, cloud saves, comments, ratings and collections. What still remains after deletion is listed item by item in the Privacy Policy.`,
    },
    {
      id: 'game-files',
      title: 'Game files and intellectual property',
      body: `### The games are not ours

Copyright and trademark in the games, characters, names, music and artwork on this site belong to their respective owners. 8BitGo claims no rights in them and is not affiliated with, sponsored by or endorsed by those owners.

### What we actually offer

- **Homebrew and openly licensed works** — where the author permits free distribution.
- **Older works of unclear rights status** — a large number of last-century commercial games whose ownership cannot be established from public sources, and whose original publisher may no longer exist. For these we operate **notice and takedown**: on a valid notice from a rights holder or their authorised agent we remove the item without argument.
- **Your own files** — in "Play local" you can pick a ROM from your own computer. Those files are **read inside your browser only and are never uploaded to our servers**.

### What you must do

Only run games you are **legally entitled to hold a backup of**, or homebrew and openly licensed works. Whether the law where you live permits you to hold a given backup is for you to judge and to bear.

### The site itself

8BitGo's interface design, code, written copy, interface icons and the original curation and descriptions on the site belong to the operator, except where another source is credited. Use the site freely, but please do not copy or mirror it wholesale, or repackage its content as your own product.`,
    },
    {
      id: 'dmca',
      title: 'Copyright complaints and takedown',
      body: `If you are a rights holder or their authorised agent and believe something here infringes your rights, email [${CONTACT}](mailto:${CONTACT}) with "Copyright" in the subject line.

So that it can be handled quickly, please include:

1. Your name, the rights holder you represent, and a contact address we can reply to.
2. The specific work you claim rights in.
3. The **full URLs** on this site of the material complained of, one per line.
4. A statement that you believe in good faith that the use is not authorised.
5. A statement that the information in your notice is accurate and that you are entitled to act for the rights holder.

### What we do

- On a valid notice we remove or block the material as soon as we can. One person handles this, so allow a little time — but it will not be left undone.
- If the material was submitted by a user, we notify that user and may act on their account.
- Accounts that repeatedly submit infringing material are banned.

### If you think we removed something wrongly

If your material was removed but you believe you hold the rights or that the use was permitted, reply with your reasoning and any evidence and we will look again.`,
    },
    {
      id: 'your-content',
      title: 'Content you submit',
      body: `You may submit comments, ratings, collections, a nickname and avatar, game suggestions, and chat messages while streaming.

### What is public

- **Comments** are public and show your nickname, your avatar and a marker for the **country or region you were in when you posted**.
- **Ratings** are shown in aggregate.
- **Collections are public without exception** — there is no "visible only to me" option. A collection carries your nickname and avatar. If you do not want a list to be seen, do not make it a collection.
- **Chat messages** are visible to everyone in the stream room.

### The licence you give us

You keep the rights in what you submit. You also grant us a **non-exclusive, royalty-free, worldwide** licence to store, display, reproduce and translate that content on the site and in the site's public listings — the minimum a website needs in order to run. The licence ends when you delete the content, though we cannot claw back anything others have already reposted or that search engines have cached.

### What not to submit

Unlawful material, anything infringing someone else's rights, abuse and personal attacks, spam, other people's personal information, malicious code, and anything inappropriate involving minors. We may remove any of it without prior notice.

### About game suggestions

When you submit a game, the file you upload and the notes you write are sent to the operator **by email**, and that email includes **your nickname, your email address and your user ID**. The file does not enter the site's database. Please do not submit files you have no right to distribute.`,
    },
    {
      id: 'broadcast',
      title: 'Streaming, multiplayer, and what is publicly visible',
      body: `> Please read this clause in full. It describes the default, not a feature you have to switch on.

### Playing means streaming

Streaming on this site is **on by default**: when you start playing, a stream room is created automatically and appears in the public lobby. Any visitor can open it and watch.

What the room exposes:

- Your **game picture and sound**, live
- Your **nickname** (a random guest name if you are not signed in)
- Your **country or region**, device type and network latency
- Chat messages from you and from viewers

### An important technical limitation

Capture relies on the browser's screen-sharing capability. On browsers that support Region Capture we crop to the game area; **on browsers that do not, what goes out is the whole browser tab.** Do not keep anything you would not want seen in the same tab.

### How to turn it off

The player has a "Private" switch. With it on, no public room is created. The setting lives in your browser's local storage — **clearing browser data returns it to the streaming default.**

### Multiplayer and peer-to-peer connections

Stream and multiplayer audio/video travel **peer to peer (WebRTC)** and are not relayed through our servers. That means:

- Whoever connects to you — a viewer or an opponent — **can learn your IP address**. This is inherent to WebRTC, not a choice we made; it is true of any service built on it.
- When a direct connection cannot be made, traffic is relayed, and the other side then sees the relay's address instead. The relay providers are listed in the Privacy Policy.

### Your responsibility on stream

Do not broadcast infringing material, unlawful material or other people's private information. What you broadcast is on you.`,
    },
    {
      id: 'conduct',
      title: 'House rules',
      body: `While using this site, please do not:

- Scrape the site's content or game files at scale with automated tools.
- Attack, scan or load-test the site, or try to defeat access controls, age checks or rate limits.
- Forge requests to inflate play counts or ratings, or use multiple accounts to manipulate ratings.
- Impersonate anyone, or claim an official relationship with 8BitGo.
- Resell the service, or repackage the site's content as a paid product.
- Upload malicious code, or use the multiplayer, submission or save endpoints to move data for non-gameplay purposes.
- Interfere with other people's play, including harassing them in streams and multiplayer.

Breaking any of these lets us restrict or end your access immediately.`,
    },
    {
      id: 'saves',
      title: 'Cloud saves',
      body: `Once signed in you can store save data on our servers. Note that:

- Each save is capped at 4 MB, each account at 200 saves and 64 MB in total. Past that you have to delete something first.
- **Cloud saves are not a backup service.** They exist so you can carry on across devices; they are not a safe sole copy. Download anything you care about.
- We make a genuine effort to keep them, but we do not promise they will never be lost. Database faults, migrations and mistakes can all corrupt or lose saves.
- Deleting your account permanently deletes your cloud saves. They cannot be recovered.
- You can also keep saves in your browser or download them as files. Saves kept in the browser disappear when you clear browser data, and that is not something we can restore.`,
    },
    {
      id: 'availability',
      title: 'Availability and changes',
      body: `Everything on this site is **free today** — no ads, no paywall. In return:

- We give **no availability commitment**. There is no SLA and no uptime guarantee. The site may be unavailable at any time for maintenance, faults, migration, or reasons personal to the operator.
- We may add, change, suspend or **permanently remove** any feature and any game at any time. A game you are playing may disappear because of a copyright notice.
- If paid features are ever introduced we will say so clearly before charging anything, and we will not abruptly put today's free core features behind a paywall.
- If the site shuts down for good we will try to announce it in advance and leave a window to export saves, though we cannot promise that if we are forced to stop immediately.`,
    },
    {
      id: 'third-party',
      title: 'Third-party services and external links',
      body: `The site depends on several third-party services for sign-in, email, content delivery and network connectivity. Those services are run by their own providers under their own terms and privacy policies. The full list is itemised in the Privacy Policy.

The site may also link to external websites. We do not control their content and are not responsible for it.

When a third-party service fails, the matching feature here fails with it, and that is outside what we can fix.`,
    },
    {
      id: 'disclaimer',
      title: 'Disclaimer',
      body: `To the fullest extent permitted by applicable law:

**The site is provided "as is" and "as available", without warranty of any kind, express or implied**, including without limitation merchantability, fitness for a particular purpose, non-infringement, and any warranty of uninterrupted, error-free or virus-free operation.

We specifically do not warrant:

- that the content is accurate, complete or current;
- that any game will run correctly on your device and browser;
- that saves will not be lost or corrupted;
- that the site or any third-party service will be uninterrupted;
- that your use of this site is lawful where you are.

Emulators run third-party software and may behave differently from the original hardware. You use them at your own risk.`,
    },
    {
      id: 'liability',
      title: 'Limitation of liability',
      body: `To the fullest extent permitted by applicable law, the operator is not liable for:

- loss of data, including cloud and local saves;
- loss of profit, goodwill or opportunity;
- indirect, incidental, special, punitive or consequential damage;
- anything arising from your breach of these terms, your breach of local law, or your running game files you had no right to hold;
- anything arising from your picture, sound, IP address or other information becoming known to others while streaming or playing multiplayer;
- the acts or failures of third-party services.

Where applicable law does not permit a full exclusion, the operator's total aggregate liability is limited to **the amount you have actually paid for the service** — which, the site being free, is normally zero.

Nothing here excludes liability that cannot be excluded by law, such as for wilful misconduct, gross negligence or personal injury.`,
    },
    {
      id: 'indemnity',
      title: 'Indemnity',
      body: `If your use of this site — in particular the content you submit, the files you send in, what you broadcast, or your running game files you had no right to hold — leads a third party to bring a claim, complaint or proceeding against the operator, you are responsible for the resulting liability, loss and reasonable costs of responding.`,
    },
    {
      id: 'termination',
      title: 'Termination',
      body: `You may stop using the site at any time, or close your account as described under "Accounts".

We may suspend or end your access at any time if you breach these terms or if we are legally required to.

After termination, the clauses on intellectual property, the content licence, disclaimer, limitation of liability, indemnity and governing law continue to apply.`,
    },
    {
      id: 'changes',
      title: 'Changes to these terms',
      body: `These terms may be updated. A new version takes effect when it is published on this page, and the "Last updated" date at the top changes with it.

For material changes affecting your rights we will show a prominent notice on the site. Continuing to use the site after a change takes effect means you accept the new version.

We do not keep a public archive of earlier versions. If you need the version as it stood on a given day, keep your own copy.`,
    },
    {
      id: 'law',
      title: 'Governing law and disputes',
      body: `These terms are governed by and construed under **the laws of Malaysia**, without regard to conflict-of-laws rules.

For disputes arising out of these terms or the service, both sides will first try in good faith to resolve the matter by email. Failing that, the dispute goes to the courts of competent jurisdiction in Malaysia.

If any clause is held invalid or unenforceable, it is narrowed or severed to the minimum extent necessary and the rest remains in full force.

### Language versions

These terms exist in several languages. For convenience, non-Chinese versions may be machine-assisted translations. **If the versions differ or conflict, the Simplified Chinese version prevails.**`,
    },
    {
      id: 'contact',
      title: 'Contact us',
      body: `For questions about these terms, or to raise a copyright complaint, an account issue or a data request:

- [${CONTACT}](mailto:${CONTACT})

Please state the subject clearly (for example "Copyright", "Account deletion", "Data request") — it gets your mail sorted faster.`,
    },
  ],
}

export const privacyEnglish: LegalDocCopy = {
  seoTitle: 'Privacy Policy',
  seoDescription:
    'The 8BitGo privacy policy: what we collect, what "streaming is on by default" means, how IP addresses and browser storage are used, which third parties are involved, how long data is kept, and how to delete yours.',
  h1: 'Privacy Policy',
  updatedLabel: 'Last updated',
  updated: UPDATED,
  tocLabel: 'Contents',
  intro: `This policy explains what information 8BitGo collects, why, who it goes to, how long it is kept, and how you get rid of it.

We have tried to describe **what the code actually does** rather than adapt a generic template. A few items do not read well — game sessions stream publicly by default, and anonymous ratings store an IP address in the clear — but writing them down is the point.

**If you read one line of this:** no cookies, no ads, no analytics, no profiling, nothing sold; but **playing a game creates a public stream room by default**, so please read section 7.`,
  sections: [
    {
      id: 'controller',
      title: 'Who handles your data',
      body: `The site is run by one independent developer acting as an individual (see the Terms of Service). In data-protection terms, that operator is the **data controller**.

Any data request — access, correction, deletion — goes to [${CONTACT}](mailto:${CONTACT}) with "Data request" in the subject line.

There is no data protection officer and no representative office. All mail is handled by the operator personally.`,
    },
    {
      id: 'no-account',
      title: 'Playing without an account: what we know then',
      body: `Most of the site works without registering. Even then, the following reaches us:

- **Your IP address** — a consequence of how the network works; every website receives it. What we do with it is in section 9.
- **A country or region inferred from it** — used for regional markers and distribution stats. This step happens **offline on our own server** against a local IP-geolocation database. **Your IP is never sent to a third-party geolocation service.**
- **Browser and device type** — inferred from the User-Agent, to decide whether to show touch or keyboard hints.
- **Which games you played, for counting** — so that play counts can be tallied without keeping IP addresses around, we store a **one-way hash** of the IP as a de-duplication key (section 9).
- **Any anonymous rating you choose to leave** — see the note in section 9 about ratings storing an IP address.

Without an account we do not know who you are, and we do not assign you an identifier that can be tracked across other sites.`,
    },
    {
      id: 'account-data',
      title: 'Registration and sign-in data',
      body: `### What you give us directly

- **Email address** — the account identifier; required.
- **Nickname** — shown publicly.
- **Password** — stored only as a bcrypt hash. We cannot see it and cannot recover it. Accounts created by emailed code or third-party sign-in have no password.
- **Avatar** — an emoji, not an uploaded image.

### What we receive from third-party sign-in

Signing in with Google, Microsoft or Apple sends us, and we store, your **verified email address** and your **display name** (truncated, used as your nickname). We do **not** request your contacts, cloud storage, calendar or social connections.

If you choose "Hide My Email" with Apple, what we store is the private relay address Apple gives us; we never see your real mailbox.

### Accounts are merged on email

Different sign-in methods pointing at the same **verified** email address land in the same account. We do not keep a separate record per sign-in method.

### Where the sign-in credential lives

After a successful sign-in the server issues a token valid for **30 days**, stored in your browser's local storage. Two things follow from that:

- It is not an HttpOnly cookie, so **scripts on this origin can technically read it** (the third-party scripts the site loads are in section 11).
- Changing your password, changing your email or "sign out everywhere" immediately invalidates every token issued before.

Sign out when you have used a shared computer.`,
    },
    {
      id: 'birth-date',
      title: 'Date of birth',
      body: `It has exactly one purpose: deciding whether you may open **adult-rated** games.

- We store the **full date** (year, month, day), because turning 18 has to be compared by day; a year alone gets it wrong.
- Age is recomputed on every request, so access begins on your 18th birthday with nothing to re-enter.
- Your date of birth is **visible only to you and to the operator**. It never appears in comments, streams or any public data, and it is not written to logs or URLs.
- **It is write-once**: once entered you cannot change it. That is to stop anyone from retrying dates until one passes. If you got it wrong, email [${CONTACT}](mailto:${CONTACT}) and the operator will clear it so you can enter it again.
- If you never play adult-rated games you can leave it empty forever.`,
    },
    {
      id: 'ugc',
      title: 'What you post, and who can see it',
      body: `### Comments

The text, your nickname and your avatar are **public**. A comment also carries a marker for the **country or region you were in when you posted**, which is likewise public. It is captured at the moment of posting and never changes or follows your location.

When you delete your own comment it stops appearing on the site, but **the original text is retained in the database** (flagged as deleted) so that later complaints and appeals can be handled. Closing your account removes these records entirely.

Comments have a five-minute editing window.

### Ratings

Ratings are shown as an aggregate; who voted is not displayed. But for **anonymous ratings** (left while not signed in) we store your IP address — see section 9.

Ratings left while signed in **do not store an IP address**.

A rating also records a country or region marker. That marker is **not displayed publicly**; it exists only for investigating vote manipulation after the fact.

### Collections

**Collections are public without exception.** There is no "only me" switch. The title, description and game list, along with your nickname and avatar, are visible to anyone. If you do not want a list seen, do not make it a collection.

### Submitting a game

When you submit, the file you upload and the notes you write, together with **your nickname, email address and user ID**, are sent to the operator's mailbox through an email provider (section 11). None of it enters the site's database — it exists only in that email. The reply-to address is set to yours so the operator can answer you directly.

### Stream chat

Chat lives in server memory only (the last 30 messages per room) and is gone when the room closes; it is never written to the database. While the room is open, though, it is visible to every viewer.`,
    },
    {
      id: 'broadcast',
      title: 'Streaming and multiplayer — note that this is on by default',
      body: `> This is the section of this policy you most need to read.

### The default

**When you play a game here, a public stream room is created automatically.** It appears in the stream lobby and any visitor can watch. You are not asked to confirm.

What the room makes public:

- Your **live game picture and sound**
- Your **nickname** (a random guest name when you are not signed in — stored in your browser, so it stays the same across sessions)
- Your **country or region**, device type (mobile or desktop) and **network latency**
- Which game you are playing, when you started, and the current viewer count

### An important limit on what gets captured

Capture relies on the browser's screen-sharing capability. Browsers that support Region Capture are cropped to the game area; **browsers that do not broadcast the entire tab.** Do not keep anything you would not want seen in the same tab.

### How to turn it off

The player has a "Private" switch. With it on, no public room is created.

The switch is stored in your browser's local storage (key 8bit.live.private). So: **clearing browser data, changing browser or changing device returns it to the streaming default.**

### The other side can see your IP address

Stream and multiplayer audio/video travel **peer to peer (WebRTC)** and are not relayed through our servers. Whoever connects to you — a viewer or an opponent — **can therefore learn your IP address**. This is inherent to the WebRTC protocol rather than something this site chose, and it is true of any service built on it.

When a direct connection cannot be made, the media goes through a **relay server**, and the other side then sees the relay's address rather than yours. Relay and hole-punching providers are in section 11.

### What the server keeps

- Room information, including the streamer's IP address (used to cap how many rooms one address may open), exists **in server memory only**; it is gone when the room closes or the service restarts, and is never written to the database.
- The audio and video **do not pass through our servers and are not recorded or stored by us**.
- If a viewer records their own screen we have no way to know or to prevent it.`,
    },
    {
      id: 'saves',
      title: 'Save data',
      body: `### Cloud saves

Once signed in you can store saves on our servers. Cloud saves are **private**: the endpoint requires a signed-in account and every query is filtered by your user ID. There is no public read path and no sharing feature.

One detail worth stating: if you save a game from a **ROM you uploaded yourself**, the save's identifier includes **that file's filename** (in the form of "local" plus the filename). So what the file on your computer is called is stored on the server. Its contents are not.

### Local saves

If you choose local storage, saves live in your browser's IndexedDB and are not uploaded. Clearing browser data removes them, and we cannot restore that.

### Local ROMs and caching

- A ROM you pick in "Play local" is **read inside your browser only and is not uploaded to our servers**.
- Game files you have downloaded from this site are cached in your browser's IndexedDB to speed up a second visit, and are evicted automatically under the browser's storage quota.
- Save data from Flash games (the old "shared object" mechanism) lives in your browser's local storage and is likewise not uploaded.`,
    },
    {
      id: 'ip',
      title: 'IP addresses and network information',
      body: `IP addresses get four quite different treatments here. Each in turn:

### One — anonymous ratings: stored in the clear, with no expiry

If you rate a game **while not signed in**, we store your IP address **in the clear in the database** as the basis for "don't let the same person vote twice". There is currently **no automatic cleanup**, so that row stays.

Two consequences you should know:

- This is the only place on the site that keeps an IP address in the clear long term.
- A second person behind the same outbound address overwrites the first person's rating (for instance from one office or household network).

If you would rather not leave that row, sign in before rating — **ratings from signed-in users store no IP address**. You can also delete your rating at any time.

### Two — play counts and collection views: one-way hash, no expiry

To tally play counts and view counts without keeping IP addresses, we take the IP (not signed in) or the user ID (signed in), combine it with a secret held only in server configuration, and store only the **HMAC-SHA256** result. The secret is not in the database, so the hash cannot be reversed to an IP even by someone holding a copy of the database.

These rows have **no expiry** and **survive closing your account** — they are linked to a game rather than to an account, so the cascade on deletion does not take them. They can no longer be matched to you, but they are strictly speaking derived from your data, which is why they are named here.

### Three — held in memory only

- **Rate-limit** counters, grouped by address, on a sliding window of at most one hour.
- The **streamer's address** for rooms and streams, only while the room exists.
- The **IP-to-country lookup cache**, a few thousand entries, cleared wholesale when full.
- The **DOS multiplayer relay** keys room membership on "address plus port", only for the life of the connection.

All of this disappears when the process restarts and is never written to the database.

### Four — written to server logs

The site runs **no access-log middleware**; requests are not logged one by one. A small number of cases do write an address to the server log:

- The first time after start-up that the reverse-proxy configuration looks wrong, the address seen at that moment is printed once, for diagnosis.
- When sending a verification code, if the client address looks unroutable, it is recorded once.

Infrastructure providers (the server host, Cloudflare) may keep their own access logs at their own layer; that part is governed by their policies.

### A public self-check endpoint

The site has a public endpoint at /api/diag which echoes back **the caller's own** network information (your address, proxy-chain headers, country, device class) for network troubleshooting. It only ever returns your own data and cannot be used to look anyone else up — but it is an endpoint that needs no sign-in, so it is named here.`,
    },
    {
      id: 'browser-storage',
      title: 'What is stored in your browser',
      body: `### We do not use cookies

This site **sets no cookies** and the server sends no Set-Cookie. There is therefore no cookie banner, because there is no cookie to consent to.

What we use is the browser's local storage, session storage and IndexedDB. All of it stays on your device and is not sent to the server automatically.

### Kept until you clear it (local storage)

- The **sign-in token** (valid 30 days) and a **cached copy of the current user** (including email and nickname)
- Your **interface language** choice
- An **anonymous rating identifier** — a random string, sent to the server with each anonymous rating
- **Guest play history** (the "recently played" list when not signed in, up to 12 entries)
- **Recent search terms** (up to 8, local only, never uploaded)
- Your **guest nickname** for multiplayer and streaming
- The streaming **"Private" switch**
- Your **save location** choice (local, cloud or download)
- **Key and gamepad mappings**, touch-pad visibility, sidebar state and other interface preferences
- **Flash game save data**

### This tab only (session storage, gone when it closes)

The one-time anti-forgery nonce for sign-in, the page to return to after signing in, this tab's multiplayer member id, and the admin unlock flag.

### IndexedDB

Save data while not signed in; the cache of game files you have downloaded.

### How to clear it

Clearing this site's data removes all of the above (your browser's "clear site data", or the Application/Storage panel in developer tools). Afterwards you will be signed out, and local saves and the "Private" switch will be gone with it.`,
    },
    {
      id: 'third-parties',
      title: 'Which third parties are involved',
      body: `### On every visit

- **ByteDance (Toutiao) URL submission** — on every page load, and on every in-site page change, the site loads a ByteDance script that submits **the current page URL** to it for search indexing. What it sees is the page address, your IP address and your browser information. This script currently has **no switch and no consent step**.
- **Google Fonts** — one Latin interface font is loaded from Google's font service, so every page load makes a request to Google, which receives your IP address and browser information. (The Chinese pixel font is self-hosted and involves no third party.)

### Only when you trigger it

- **Google / Microsoft / Apple sign-in** — loaded or redirected to only when you click the matching button. Credentials are sent to the relevant provider during verification.
- **Hole punching and relay** — multiplayer and streaming need to traverse networks. Cloudflare's service is used by default; where it is not configured, the fallback is the public hole-punching servers of **Google** and **Twilio**. When relaying is engaged, the media passes through **Cloudflare** relay nodes (Cloudflare states that it does not retain relayed content; their policy governs).
- **DOS multiplayer** — uses the third-party net.dos.zone as the peer server by default.
- **Email delivery** — verification codes, deletion confirmations and game submissions are sent via **Resend**, which therefore sees the recipient address and the message content.

### Infrastructure, always in the path

- **Cloudflare** — the site's CDN and security layer; every request you make passes through it.
- **Object storage (assets.8bitgo.com)** — game covers and game files are served from here.
- **Server host** — the cloud provider running the backend.
`,
    },
    {
      id: 'verification',
      title: 'Search-engine verification and URL submission',
      body: `This section is kept separate from the previous one because none of it **receives any user data** — grouping them together would suggest otherwise.

### Ownership-verification tags

The page head carries ownership-verification tags for Baidu, Sogou, Shenma and ByteDance. They are **static strings and make no requests**; they exist only to prove to those search engines that we own the domain.

### Proactive URL submission (currently off)

Proactive URL submission to search engines (IndexNow, Baidu's standard submission) is **disabled**. Even when enabled, all they submit is page URLs, with no user data.

Note that this is **not the same thing** as the ByteDance entry in the previous section: that one is a script loaded in the page and carries your IP address and browser information; this one is a request our server makes, with nothing to do with visitors.`,
    },
    {
      id: 'not-doing',
      title: 'What we do not do',
      body: `This list is here because "not doing it" needs stating as clearly as doing it:

- **No advertising** and no ad-network tracking code.
- **No analytics tooling** — no Google Analytics, no Baidu Tongji, nothing of that kind.
- **No profiling.** We do not tag you with interests and do not run personalised ad targeting.
- **We do not sell, rent or trade** your personal information.
- **We do not send visitor IP addresses to third-party geolocation services** — country lookup happens offline on our own server.
- **We do not ask for** your contacts, location permission, camera or microphone (streaming captures the page, not a camera).
- **We do not track you on other websites.** There is no cross-site identifier.
- **We do not record** stream audio or video.`,
    },
    {
      id: 'retention',
      title: 'How long things are kept',
      body: `- **Your account and its related data** (favourites, recently played, cloud saves, comments, ratings, collections) — until you close it or the operator deletes it. **There is no automatic deletion for inactivity.**
- **Sign-in token** — 30 days; invalidated at once by a password change, an email change or "sign out everywhere".
- **Email verification codes** — valid 10 minutes, deleted on successful use. Cleanup happens opportunistically the next time a code is sent; **there is no scheduled job** — so in a quiet period expired rows may linger a while. Codes themselves are stored hashed, never in the clear.
- **Guest recently-played** — the last 12 entries; writing a new one pushes out the oldest.
- **Comments** — kept long term. Deleting your own hides it from the site but keeps the record; closing your account deletes it fully.
- **The clear-text IP on anonymous ratings** — **no expiry, no cleanup** (section 9).
- **Play-count and view-count hash identifiers** — **no expiry**, and retained after an account is closed.
- **Country markers on comments and ratings** — kept long term, frozen at the moment of posting by design.
- **Rate-limit counters** — at most one hour, memory only.
- **Rooms, streams, chat and the streamer's address** — for the life of the room, memory only, gone on restart.
- **Temporarily uploaded J2ME packages** — removed by a scheduled sweep after 30 minutes.
- **Data in your browser** — apart from the admin upload-resume state (7 days), none of it expires; you clear it yourself.`,
    },
    {
      id: 'rights',
      title: 'Your rights, and how to exercise them',
      body: `### What you can do yourself

- **See** your account information — in your profile.
- **Change** your nickname, avatar, email address and password.
- **Delete** an individual comment, rating, collection or cloud save.
- **Close your account** — start it from your profile and confirm with the emailed code. The account goes, along with favourites, recently played, cloud saves, comments, ratings and collections.
- **Clear local data** — clear this site's data in your browser.
- **Stop streaming** — the "Private" switch in the player.

### What needs an email

- **Correcting your date of birth** — it is write-once, so the operator has to clear it before you can re-enter it.
- **Getting a copy of your data** — **there is no automated export today.** Email us and the operator will assemble your account's data by hand and reply. This is not an instant self-service flow, so allow time.
- **Objecting to or restricting a particular use** — email us and say which one.

Please write from **the address your account is registered to**, otherwise we cannot confirm it is you.

### What remains after you close your account

Stated plainly: closing an account is **not** the same as erasing every piece of data derived from you. The following records have no foreign key to your account and are not removed by the cascade:

- The **hash identifiers** behind play counts and collection views (not reversible to an IP address or user ID)
- Anonymous ratings and their IP rows left **while you were not signed in** (they carry no user ID, so the system cannot tell which were yours)
- Unexpired email verification code rows (they lapse on their own within 10 minutes)

If you want those handled too, say so in your email and the operator will find and delete them manually.

### Complaints

If you think we have handled your data improperly, please write to us first. You also keep the right to complain to the data protection authority where you live.`,
    },
    {
      id: 'children',
      title: 'Children',
      body: `This site is **not intended for anyone under 13** and we do not knowingly collect their personal information.

There is **no age check at the entrance to the site** — the 18-or-over check runs only when opening adult-rated games. In other words, we cannot technically stop someone who misstates their age from browsing.

If you are a parent or guardian and find that a child under 13 has created an account here, email [${CONTACT}](mailto:${CONTACT}) and we will delete the account and its data.

Please pay particular attention to section 7: **playing creates a public stream room by default.** If you intend to let a child use this site, turn on "Private" in the player first, and note that clearing browser data undoes that setting.`,
    },
    {
      id: 'transfer',
      title: 'International transfers',
      body: `The site's servers, CDN and third-party services are spread across several countries and regions. Using the site means your data may be transferred outside your own country and stored and processed there, in places whose data protection standards may differ from those where you live.

The providers involved are listed in section 11, each under its own transfer safeguards.`,
    },
    {
      id: 'security',
      title: 'Security',
      body: `What we do:

- HTTPS throughout.
- Passwords salted and hashed with bcrypt; never stored in the clear.
- Email codes stored only as hashes, compared in constant time, voided after five wrong attempts.
- Third-party sign-in carries a one-time anti-forgery nonce, and the sign-in token comes back in the **fragment** part of the URL so that it never reaches server or CDN access logs.
- The secret used to hash IP addresses lives in server configuration, not in the database.
- The admin password is kept in session storage only and is gone when the tab closes.

Limits we should state honestly:

- **The sign-in token is in local storage rather than an HttpOnly cookie**, so scripts on this origin can technically read it (see section 11 for the third-party scripts the site loads). That is the current implementation choice, and it gives up that layer of protection.
- The site is run by one person. There is no dedicated security team and no third-party penetration test has been done.
- No system is perfectly secure. Please do not store anything here you could not afford to have exposed — this site does not need, and you should not submit, identity documents, payment card numbers or other sensitive personal information.

To report a security problem, email [${CONTACT}](mailto:${CONTACT}) with "Security" in the subject. Please hold off on public disclosure until it is fixed.`,
    },
    {
      id: 'changes',
      title: 'Changes to this policy',
      body: `This policy will change as the site does. A new version takes effect when it is published on this page, and the "Last updated" date at the top changes with it.

If a change introduces new data collection or a new third party, we will show a prominent notice on the site.

We do not keep a public archive of earlier versions. If you need the version as it stood on a given day, keep your own copy.`,
    },
    {
      id: 'contact',
      title: 'Contact us',
      body: `For any question about this policy, or to make a data request:

- [${CONTACT}](mailto:${CONTACT})

Please write from the address your account is registered to, and state the subject clearly (for example "Data request", "Delete account", "Security").

### Language versions

This policy exists in several languages, and non-Chinese versions may be machine-assisted translations. **If the versions differ or conflict, the Simplified Chinese version prevails.**`,
    },
  ],
}
