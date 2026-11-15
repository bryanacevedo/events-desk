Events Desk directory reader (Chrome extension, Manifest V3, no build step)

Load it unpacked
1. Open chrome://extensions and turn on Developer mode.
2. Press Load unpacked and pick this extension/ folder.
3. In the desk's settings make a capture key. Open the extension, type the desk's
   address, paste the key, press Save and connect, and allow the one address Chrome asks about.
4. Open the event's directory in your own logged-in browser tab, open the extension,
   pick the event, then press Read this page or Scroll and read. Stop ends it.

What it stores (chrome.storage.local): the desk's address, the capture key, the last
event picked. The running counts live in session storage and go when the browser closes.

What it reads: the names, titles, companies and locations shown on the page you
pressed the button on, and the link to each profile. It sends them to your desk only.

What it never does: read or store passwords, cookies, tokens or page content beyond
the people above; run on any page before you press a button; run in the background or
on a schedule; open pages or follow links; contact anyone. It has no content script,
no cookies, tabs, history or webRequest permission. Its permissions are activeTab,
scripting and storage; access to your desk's address is asked once, at setup.

Fixtures (extension/fixtures/) are RECONSTRUCTIONS of Swapcard's web app pattern from
public knowledge, not captures of a logged-in directory, and every person in them is
invented. A real capture replaces them when the first person loads the extension.
The optional host patterns in the manifest only name what Chrome may be asked about;
nothing is granted until you approve your desk's address.
