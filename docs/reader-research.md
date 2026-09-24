# Reader research notes

Short notes on what makes reading on a phone comfortable, and how EasyRead uses them.

## What readability research says

- Line length: about 45 to 75 characters per line reads best. Around 66 is the classic target. The British Dyslexia Association suggests 60 to 70. WCAG 1.4.8 says 80 or fewer.
- Line height: 1.4 to 1.6 for body text. 1.2 or less feels cramped, mostly for people with low vision or dyslexia. Longer lines need a bit more line height.
- Font size: readers want to pick it. There is no single right size, because eyes, screens and lighting differ.
- Dyslexia: evidence for special "dyslexia fonts" is weak. What helps is clear letter shapes, a big x-height, left aligned text, and a bit more spacing. Atkinson Hyperlegible was built for clear, hard to confuse letters.
- Left aligned text avoids the uneven "rivers" of space that justified text can make on narrow screens. If you justify, turn on hyphenation so gaps stay small.
- Dark mode helps in low light. Pure white on pure black can feel harsh ("halation"), so a softer, low contrast night theme is useful. True black saves battery on OLED screens.

## What e-reader users value (Kindle, Apple Books, KOReader, Moon+ Reader, ReadEra)

- Full control over font, size, spacing and margins, with a live preview.
- Several themes: light, sepia, dark, black, and a dim night theme.
- Page turning by tapping the left or right edge, swiping, or using keys. Tap the middle to show menus.
- Choice between pages and continuous scroll.
- Progress shown as a percentage, and "time left in chapter".
- Table of contents, bookmarks, and the app remembering where you stopped.
- No distractions while reading: menus hide until you ask for them.
- Works offline and keeps your files private.

## How EasyRead applies this

- Default text: serif (Literata), 19px, line height 1.6, left aligned, max width 66 characters. Width can go from 45 to 80 characters.
- Font choices: serif (Literata), sans (system font), and Atkinson Hyperlegible for easy letter recognition.
- Themes: light, sepia, dark, black (OLED), and night (dim warm text on black, low contrast).
- Alignment: left or justify. Hyphenation is on by default and can be turned off.
- Tap zones: left 30% goes back, right 30% goes forward, middle opens the menu. Swipe and arrow keys also work.
- Footer shows chapter name, percent read, and minutes left in the chapter (based on about 250 words per minute).
- Table of contents from the PDF outline when it has one, else from detected chapter headings.
- Bookmarks, and the reading spot is saved on your device automatically.
- Everything runs in your browser. Files never leave your device.
- Follows your system dark mode, reduced motion, and phone safe areas (notches).

## Scanned PDFs (OCR)

- A scanned page (one with no text layer) is sent as an image to a cloud reader for OCR: Google Gemini first, then Groq (Llama 4) if Gemini is busy or down. This is the one place in EasyRead where page content leaves your device, and it only happens for pages that need OCR. Both give noticeably cleaner text than reading it on your device: fewer garbled words, correct paragraph breaks, and correctly labelled headings.
- If neither cloud reader can be reached for some pages, EasyRead does not read them on your device on its own. It asks first: a prompt lets you choose to read those pages on this device (slower, less accurate) or try the cloud again later. Nothing runs on your device until you say so.
- The on-device fallback cleans up each page image first (deskew, contrast, adaptive black and white), then repairs obvious OCR mistakes in English with a word list. On a moderately degraded test scan this took word accuracy from 7% to 99%. Very low resolution scans are still poor.
- Early testing on-device with Tesseract alone gave results like "20: I)C)PJCYT CXDLJBJIT:" for headings and merged words like "thefool" and "commil". Gemini and Groq read the same pages accurately, which is why they come first, with on-device OCR only as a last resort you opt into.
- OCR takes a few seconds per page, so you can start reading as soon as the first pages are done. Scanning can be paused, resumed and cancelled, and it picks up again if you close the tab.
- The screen is kept awake while scanning when the browser supports it.
- Requests are limited to a few pages at a time (not all pages at once), with automatic retries if the service is briefly busy.
- Language data for on-device OCR (English, Indonesian and others) downloads once, then is cached. The cloud readers do not need this; the language picker mainly helps on-device OCR, and is also passed to Gemini and Groq as a hint for the page's language.
- Cost is small: a page costs a small fraction of a cent to read with Gemini or Groq.

## Limits

- Complex layouts (two columns, tables, footnotes, magazines) may come out in the wrong order.
- OCR quality depends on scan quality. Blurry, skewed or handwritten pages give poor text.
- Images and figures are not shown in the reflowed text.

## Sources

- Baymard Institute, "Readability: The Optimal Line Length": https://baymard.com/blog/line-length-readability
- UXPin, "Optimal Line Length for Readability": https://www.uxpin.com/studio/blog/optimal-line-length-for-readability/
- Accessible text checklist: https://a11ywithdiana.substack.com/p/research-backed-accessible-text-checklist
- Inclusive typography: https://www.disabilityworld.org/articles/inclusive-typography-and-readability/
- KOReader user guide: https://koreader.rocks/user_guide/
- KOReader page turn gestures: https://www.ereadersforum.com/threads/how-to-customize-page-turns-and-gestures-in-koreader-on-any-e-reader.7807/
- Moon+ Reader overview: https://alternativeto.net/software/moon-reader/about
