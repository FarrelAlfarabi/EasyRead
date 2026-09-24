# ReadEra parity

ReadEra is a free Android and iOS reader for PDF, EPUB and more. This page lists its main features and whether EasyRead has them.

Status values:
- **done**: EasyRead already had it before this round.
- **added now**: built in this round.
- **not doing**: skipped, with the reason.

Sources: the ReadEra site (https://readera.org), Google Play listing (https://play.google.com/store/apps/details?id=org.readera) and App Store listing (https://apps.apple.com/app/readera-book-reader-pdf-epub/id1441824222).

## Formats

| Feature | Status | Notes |
| --- | --- | --- |
| PDF | done | Reflowed text, plus OCR for scanned pages. |
| EPUB 2 and 3 | added now | Parsed in the browser (JSZip, loaded only when needed). Headings, bold, italic, lists, quotes, images, footnotes, table of contents. |
| DRM protected EPUB | added now | Detected and refused with a clear message. |
| MOBI, AZW3, FB2, DjVu, DOCX, RTF, TXT, CHM | not doing | Each needs its own parser. PDF and EPUB cover most books people have. |
| Archives (ZIP of books) | not doing | Rare, and adds a second import path. |

## Library

| Feature | Status | Notes |
| --- | --- | --- |
| Covers | added now | EPUB cover, first PDF page, or a generated cover. |
| Cover grid and list view | added now | |
| Sort (recent, title, author, progress, added) | added now | |
| Search in library | added now | Title and author. |
| Filter by reading status | added now | To read, Reading, Finished. |
| Favorites | added now | |
| Collections | added now | Create, rename by re-adding, assign from the book menu. |
| Authors view | added now | Books grouped by author. |
| Auto-scan device folders | not doing | Browsers cannot scan folders on their own. You add books by choosing or dropping files. |
| Delete book | done | |

## Reading

| Feature | Status | Notes |
| --- | --- | --- |
| Page and scroll modes | done | |
| Table of contents | done | EPUB: nav.xhtml or toc.ncx. |
| Bookmarks | done | |
| Go to page or percent | added now | |
| Back after a jump | added now | Chip appears after following a link, search hit or contents entry. |
| Full-text search | added now | |
| Highlights in several colors | added now | Yellow, green, blue, pink. |
| Notes on highlights | added now | |
| Export notes | added now | Copy, share or download as text. |
| Footnote popups | added now | EPUB footnotes open in a popup. |
| Image zoom | added now | Tap an image. |
| Dictionary and translate | added now | Lookup links (Wiktionary, Google Translate) from the selection menu. Device dictionary apps cannot be called from a browser. |
| Text to speech with sentence highlight | added now | Uses the voices on your device. |
| Original PDF page view | added now | With margin crop and zoom. |
| Brightness | added now | Dim overlay on top of the page. The browser cannot change real screen brightness. |
| Keep screen on | added now | Wake Lock API. |
| Reading stats | added now | Time read, days, pages per day, time to finish. |
| Keyboard page turn | done | Arrows, Page Up/Down, space, media keys. |
| Volume keys to turn pages | not doing | Browsers do not receive phone volume key presses. |
| Last read marker | added now | Tap a word in marking mode. EasyRead extra, not in ReadEra. |

## Settings

| Feature | Status | Notes |
| --- | --- | --- |
| Themes: day, sepia, night, and more | added now | Light, sepia, dark, dark sepia, dark gray, black, night, custom. |
| Custom text and background color | added now | With a contrast warning. |
| Fonts | added now | Literata, Source Serif, system sans, Atkinson Hyperlegible, Lexend, OpenDyslexic. |
| Font size | done | |
| Text weight | added now | Uses variable fonts. |
| Line, letter, word, paragraph spacing | added now | Line spacing was done. |
| First line indent | added now | |
| Margins, each side | added now | |
| Alignment and hyphenation | done | |
| Publisher styles on or off | added now | Off by default so your settings win. |
| Status bar items | added now | Clock, battery, progress, time left, pages left. |
| Page turn animation | added now | Can be turned off. |
| Tap zone layout | added now | Left/right, top/bottom, or mostly forward (most of the screen goes to the next page). |
| Two page spread | done | |
| Screen orientation lock | not doing | Only possible in full screen on some browsers; the phone's own lock works. |
| Cloud sync and backup | not doing | EasyRead has no accounts; everything stays on the device. |
