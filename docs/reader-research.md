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

- Pages without a text layer are read with OCR (Tesseract) inside the browser. Nothing is uploaded.
- OCR is slow on phones (a few seconds per page), so you can start reading as soon as the first pages are done. Scanning can be paused, resumed and cancelled, and it picks up again if you close the tab.
- The screen is kept awake while scanning when the browser supports it.
- Language data (English, Indonesian and others) downloads once, then is cached.

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
