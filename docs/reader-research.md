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

## Newer evidence (2025 review)

- British Dyslexia Association style guide: 16 to 19px body text (or larger), line spacing of 1.5, left aligned text, 60 to 70 characters per line, sans or rounded fonts with clear letter shapes, and a soft background (cream or pastel) instead of pure white. Avoid italics and underlining for emphasis where possible.
- WCAG 2.2 success criterion 1.4.12 (Text Spacing): content must still work when a reader sets letter spacing to 0.12em, word spacing to 0.16em, line height to 1.5 and paragraph spacing to 2em. EasyRead lets readers go at least that far on each setting.
- Bionic reading (bolding the start of each word): controlled studies found no speed or comprehension benefit, and some found it slightly slower. Snell (2024) tested it with adults and saw no gain; Doyon (2022) found the same; a 2025 eye-tracking study found no change in fixations or reading speed. EasyRead offers it only as an optional "Bold word starts" setting, off by default.
- Reading ruler: a band that highlights one line and dims the rest can help some readers keep their place. Evidence is mixed, so it is optional and off by default.
- Contrast: WCAG asks for at least 4.5:1 for body text. Very high contrast (pure white on pure black) can feel harsh for some readers, so softer dark themes are offered next to the true black one.

## How EasyRead applies this

- Default text: Literata serif, 19px, weight 400, line height 1.6, left aligned, max width 66 characters, hyphenation on. Width can go from 45 to 80 characters.
- Fonts: Literata, Source Serif, system sans, Atkinson Hyperlegible Next, Lexend and OpenDyslexic. The first five are variable fonts, so text weight can be set in small steps. OpenDyslexic is offered because some readers like it, though studies do not show it helps on average.
- A "Dyslexia friendly" preset applies the BDA and WCAG advice in one tap: Lexend, 20px, line spacing 1.8, letter spacing 0.12em, word spacing 0.16em, extra paragraph space, 60 characters per line, left aligned, no hyphenation.
- Spacing: letter (up to 0.12em or more), word (up to 0.16em or more), paragraph spacing and first line indent, all meeting WCAG 1.4.12.
- Themes and their text contrast (checked in code, see src/lib/contrast.ts):
  - Light, sepia, dark, dark sepia, dark gray and black: body text between about 11:1 and 16:1.
  - Night (dim warm text on black): about 6:1, on purpose, for reading in the dark.
  - Text before the last read marker is dimmed but stays at 4.5:1 or more, except the night theme at about 4:1.
  - Custom colours show a warning below 4.5:1.
- Tap zones: left side goes back, right side goes forward, middle opens the menu. Other layouts are in settings. Swipe and keys also work.
- Status bar: chapter, percent read and minutes left by default; clock, battery and pages left can be added.
- Everything runs in your browser. Files never leave your device, except scanned PDF pages sent to cloud OCR.
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
- Images in PDFs are not shown in the reflowed text. Use the Original page view for those. EPUB images are shown.

## Sources

- British Dyslexia Association, Dyslexia Style Guide 2023: https://www.bdadyslexia.org.uk/advice/employers/creating-a-dyslexia-friendly-workplace/dyslexia-friendly-style-guide
- W3C, Understanding SC 1.4.12 Text Spacing: https://www.w3.org/WAI/WCAG22/Understanding/text-spacing.html
- Snell, "Bionic Reading does not improve reading speed" (2024), Acta Psychologica: https://www.sciencedirect.com/science/article/pii/S0001691824001811
- Doyon, "Bionic Reading test" (2022): https://readwise.io/bionic-reading-results
- Wery and Diliberto, "The effect of a specialized dyslexia font, OpenDyslexic" (2017), Annals of Dyslexia: https://link.springer.com/article/10.1007/s11881-016-0127-1

- Baymard Institute, "Readability: The Optimal Line Length": https://baymard.com/blog/line-length-readability
- UXPin, "Optimal Line Length for Readability": https://www.uxpin.com/studio/blog/optimal-line-length-for-readability/
- Accessible text checklist: https://a11ywithdiana.substack.com/p/research-backed-accessible-text-checklist
- Inclusive typography: https://www.disabilityworld.org/articles/inclusive-typography-and-readability/
- KOReader user guide: https://koreader.rocks/user_guide/
- KOReader page turn gestures: https://www.ereadersforum.com/threads/how-to-customize-page-turns-and-gestures-in-koreader-on-any-e-reader.7807/
- Moon+ Reader overview: https://alternativeto.net/software/moon-reader/about
