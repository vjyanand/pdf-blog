---
title: "Rebuilding the Table Engine in Rust: What the Measurements Said"
date: 2026-09-10
author: Vijay
gravatar: 7e491724a0d1b989ddc6948e87d71d7159182eabae739da287c29f12199a4d14
twitter: '@vjyanand'
---

We rebuilt the engine behind PDF Table Convert from scratch in Rust. Same
foundations — xpdf for text and rendering, OpenCV for the image work, WebAssembly
so your file never leaves the browser — but every line above them written new.

What follows is how the port was structured, and then what the measurements
said — including the several times they said we were wrong. Nearly every real
improvement came from checking a belief rather than acting on it, and three of
them came from discovering that a test or a metric was itself the bug.

---

## What we kept, and why the port needed a shim

The tempting version of this project replaces everything. There are pure-Rust
PDF crates now, and pure-Rust image libraries, and swapping to them would have
deleted the C++ from the build entirely.

We kept xpdf and OpenCV, deliberately.

xpdf's text output is unusually good at deciding where one word ends and the
next begins, and it reports two things almost nothing else does: which line each
word was on, and how large its type was. The whole business of reassembling a
cell whose text the renderer broke in half rests on those. OpenCV gives us
morphology, contours and neural-network inference from one already-tuned
dependency, with identical arithmetic native and in the browser. Replacing
either would have meant re-validating every detection against a new backend for
no gain a user could see.

That decision has a price, and the price is a shim.

Rust's usual approach to a C library is to generate bindings automatically. That
does not work here, because there is nothing for it to bind to: `cv::Mat`,
`PDFDoc`, `std::vector` and the templates behind them have no C spelling. The
only workable route is a hand-written layer of C++ that flattens those types into
opaque handles and plain structs, which Rust can then speak to. Around 700 lines
of it. It is also what keeps the WebAssembly build viable, since the whole thing
still links through emscripten.

We wrote that layer with three rules. No function throws — a C++ exception
unwinding into Rust is undefined behaviour, so every one is caught at the
boundary and turned into a status code. Every allocation has exactly one matching
free, named next to it. And the surface stays small: a function exists because
the pipeline calls it, not because the library offers it.

Above the shim, the code is organised so that **anything not needing xpdf or
OpenCV lives in a crate that does not link them**. Geometry, text reconstruction,
row and column logic, the detector's output decoding — all of it builds and tests
on any machine with no C dependencies present at all. That is where most of the
208 tests live, and it is the single structural decision that made the rest of
the work reviewable.

---

## The bugs that stopped being possible

This was not a function-for-function translation. What we preserved is the
*boundary* — the JSON the browser receives, the JavaScript API, and the specific
defects we knew about. Everything inside was free to be written differently, and
the most valuable difference was making certain mistakes inexpressible.

The old code used `-1` to mean "this word belongs to no column". That is a
perfectly ordinary integer everywhere a real column index is expected, and it
behaved like one: words carrying it were collected together and emitted as a
column of their own, so page furniture arrived in the middle of the table. In the
Rust version a column index is a type you cannot construct without asking a grid
for it, and "no column" is `Option::None`. The phantom column is not fixed; it
cannot be written down.

The same move, three more times:

- A rectangle **cannot hold a negative extent**. The old row-band inference could
  produce bands of negative height from unsorted input, silently, as far
  downstream as the extracted cells.
- **No overlap is `None`, not an empty rectangle.** OpenCV collapses two
  non-overlapping rectangles to `(0, 0, 0, 0)` — a real position that then
  compares, unions and sorts like any other. Returning an `Option` forces the
  caller to say what "they don't overlap" means for them.
- **A point in PDF space and a point in image pixels are different types.** Both
  are just numbers, and mixing them produces a result wrong by a factor of about
  4.17 that still looks entirely plausible. Converting between them now requires
  naming the resolution, and cannot happen by accident.

Porting also surfaced defects by simply having to write each piece down. A
bounding-box routine that only ever *grew* three of its four edges, so it
returned the right answer only for input that happened to be sorted — true of
the rows it was tested on, false of the columns it wasn't. A flag every caller
passed identically. A comparison in the column-merge that could never fire,
because it tested a value the line above had already modified.

And one bug the shim caught before it could exist: xpdf's default text encoding
is Latin-1. Left alone, every currency symbol and accented name would have
reached Rust as invalid UTF-8.

**The honest cost.** The shim's central premise — catch every C++ exception at
the boundary — turns out not to hold under WebAssembly the way it does natively.
We found this when a missing detector file killed a whole call in the browser
while returning a clean error on the desktop. The fix was to stop relying on the
exception for something expected: check the file before handing it to OpenCV. But
it is worth knowing that the boundary is less absolute than it looks, and that
expected conditions should never travel across it as exceptions.

---

## We were rendering four times more pixels than we needed

The module felt slow in the browser. An eight-page bank statement took about
nineteen seconds end to end.

The obvious suspect was WebAssembly — everyone's first instinct is that the wasm
runtime is the tax. It wasn't. Every page was being rendered at 300 DPI, and the
original implementation renders at 150.

The 300 came from a `pHYs` chunk the old PNG writer stamped into every image.
That chunk is a claim about *print size*. It is not the resolution anything was
rendered at, and in fact the old code stamped 300 while rendering at 150 — so
the number had never been true of the image. We read it as the render
resolution, and doubling the resolution quadruples the pixels: four times the
rendering, four times the PNG encoding, four times every pass the detection
makes over the page.

| Operation, 8-page statement | 300 DPI | 150 DPI |
| --- | --- | --- |
| Render page images | 865 ms | 310 ms |
| Find table boundaries | 9,114 ms | 1,307 ms |
| Extract tables | 9,270 ms | 1,294 ms |

The whole flow went from about nineteen seconds to under three.

The number that mattered most was not the speedup. It was that detection went
from roughly **50× slower than native to 1.4×** — which is ordinary WebAssembly
overhead. The gap had never been the runtime. It was the resolution, and we had
been about to go optimising the wrong thing.

---

## Then we were paying for the same page three times

With the resolution fixed, we profiled properly rather than guessing again:

| Stage | Per page | Share |
| --- | --- | --- |
| Render | 18.2 ms | 56% |
| Ruling-line detection (morphology) | 8.8 ms | 27% |
| Text extraction | 5.0 ms | 15% |
| Column alignment | 0.1 ms | 0.2% |
| Cell assignment | 0.2 ms | 0.7% |

Two things fell out of that. **Detection is morphology** — the table logic we
had spent most of our attention on accounts for under one percent of the time,
so optimising it would have been wasted effort. And the browser was paying for
all of it three times over: rendering the page images, then finding the table
boundaries, then extracting the contents are three separate calls across the
WebAssembly boundary, and none of them remembered the last.

Three caches fixed it. Rendered pages under a 64 MB budget — about ten pages,
evicting whatever was wanted longest ago. The words of each page, unbounded,
being three orders of magnitude smaller than an image. And the detection
results, which depend on nothing but the page.

That last one needed a small restructuring: detection splits into the expensive
half, which only looks at the page, and the cheap half, which folds in any
rectangles you have drawn. The first can be cached; the second can't, because
your rectangles are an input.

Extraction went from **1,294 ms to 9 ms**. Zero cells changed.

---

## A hypothesis that died in ten minutes

When a cell is too narrow for its contents, the renderer breaks the word wherever
it happens to be. `1,28,940.07` arrives as `1,28,940.` and `07`. Join every
fragment with a space and you corrupt over half the cells on a statement; join
them all with nothing and `Deposit (Cr)` becomes `Deposit(Cr)`.

We built the rejoining rule around three signals, one of which was that the PDF's
content stream records whether there was a space after each word. That seemed
like the strongest evidence available — a space actually present in the file.

We wrote it into the code as a hypothesis, with a comment saying it had to be
measured before it was trusted. Then we measured it:

| Document | Line ends with "space after" | Without |
| --- | --- | --- |
| Credit card statement | 182 | 6 |
| Bank statement | 655 | 15 |
| Account summary | 169 | 2 |

xpdf reports "space after" for **97% of line-ending words**, whether or not the
break was forced. As a cross-line signal it carries almost nothing, and requiring
it would have suppressed essentially every join — leaving the text exactly as
broken as the naive approach we were trying to replace.

The hypothesis was ours and it was wrong. It cost ten minutes to find out,
because the decision lived in one small function and was labelled as unverified.
That labelling is the part that worked.

---

## When the metric is the bug

We score every change against a corpus of fifteen real documents. There is no
ground truth, so the harness counts damage a reader would recognise without the
original open beside them: numbers with a space through them, ragged rows,
columns nothing falls into.

One change added 539 correct cells and appeared to introduce 45 new defects.

It hadn't. `April 10, 2021` was being scored as a broken number — the token
before the space ends in a comma and contains a digit, the one after starts with
one. The rule was written for `1,00, 000` and could not tell them apart from
shape alone. A comma inside a number separates groups of two or three digits;
`2021` is four, so it is a year, not a grouping.

The real figure was nine.

This mattered more than a stray count. The flaw made the metric **get worse the
more the extractor got right**, because the cells the change added were prose
full of dates. A metric that degrades as the thing it measures improves is worse
than no metric, because it argues against every genuine improvement.

We have written its known blind spots into the accuracy log rather than quietly
tuning them away. A metric whose limits aren't recorded will eventually be
trusted where it shouldn't be.

---

## When the test is the bug

You can draw a rectangle over a region and have just that region extracted. A
user reported that it did not seem to line up with the page.

The coordinates were fine — the browser diagnostics showed the rectangle
arriving at the engine in exactly the right pixel space. The problem was one
step further in. A drawn rectangle is a *region and nothing else*: it carries no
rows and no columns. And the extractor rejected any candidate with no columns as
having no structure.

Every drawn rectangle. Every time. Drawing a box could never have worked.

It survived because we had written a test named
`a_region_with_no_structure_still_yields_rows_from_the_text` which **asserted the
broken behaviour** — that such a region yields nothing. It passed, so the defect
looked deliberate.

A region that arrives without columns now reads them from the words inside it.
The test asserts what should happen, with a note recording what it used to claim.
That note is deliberate: a test that encodes a bug is more dangerous than no
test, and it is worth leaving a marker where one was found.

---

## Three things that look like tables and aren't

Much of the accuracy work turned out to be teaching the extractor what a table
*isn't*. Each of these was found by reading output, not by reasoning about it.

**A form isn't a table.** An account details block — `Name:`, `A/C No:`,
`Branch:` — is laid out in columns because that is how forms are laid out, so
alignment detection finds it and scores it confidently. On one statement the
spurious blocks scored *higher* than the real transaction table, so no confidence
threshold could separate them. What separates them is that a form names each
value in the cell beside it: **0 of 18** rows of the real table end a cell with a
colon, against 4 of 5 and 7 of 9 in the blocks around it.

**Prose isn't a table.** A page of terms and conditions set in columns has
recurring word positions, short cells, and ordinary confidence. But read a row
across and it is a sentence in pieces — `offer is communicated | by the |
merchant | during the`. A value does not begin in the middle of a sentence.
Counting cells that start with a lowercase word separates them cleanly: real
tables sit at 0.00–0.05, blocks of prose at 0.22 and above.

**A rule typed out of dashes isn't content.** A `--------------------` spanning
the page is decoration, but it runs through every gutter between the columns and
erases the boundaries they mark. Six or more of one punctuation mark now counts
as blank, like whitespace.

---

## Right-aligned columns needed a different question

A landscape statement came back with the description and the debit amount merged
into one cell: `INW - HDFC BANK LIMITED 24,729.00`.

We had been finding columns by clustering where words *begin*. That works for
left-aligned text and fails completely for amounts, which are right-aligned —
their left edges scatter across the column, so there is no recurring start to
find. It was a limitation we had documented and never fixed.

The better question is not where words begin but **where they never are**. A
column is separated from the next by a strip of white running down the page, and
that strip is there whatever the column contains: a left-aligned description, a
right-aligned amount, a centred code. We now read the gutters at one-pixel
resolution — for every column of pixels, how many lines have a word covering it —
and a wide enough run of near-zero is a boundary.

A tenth of the lines may cross a gutter and it remains a gutter, so a single
over-long description doesn't erase a boundary that holds for every other row.

The same statement now reads:

```
Date        Description                      Instr. No.  Debits      Credits   Balance
05-10-2022  NACH DR INW - HDFC BANK LIMITED              24,729.00             4,69,079.75
06-10-2022  UPI/227963952362/CR/SUDHAK/BKID                          30.00     4,69,109.75
```

Debits and credits in their own columns — which is the entire point of a bank
statement, and was previously unrecoverable from the output.

---

## The comparison everyone thought was impossible

Both earlier implementations were said to be undiffable: the original C++ can no
longer be built against the current xpdf, so there was no reference to compare
against. That had been true for years and nobody had questioned it.

It didn't need to be built. A **compiled** C++ module was sitting in the web
app's assets directory in git, from before a later deploy overwrote the working
copy. It loads under Node with a small shim.

Running it settled several things immediately, including two we had believed
wrongly: extraction requires the page images to have been rendered first — without
that call, every page throws — and the older engine doesn't decline to handle the
last page of one statement, it crashes on it. We had taken its silence as a
judgement about what belongs in the output, and were about to write a rule based
on that reading.

With the oracle driven correctly, on an eight-page statement:

| Page | Old engine | New engine | Its rows we fail to reproduce |
| --- | --- | --- | --- |
| 1–7 | 18/28/29/28/28/26/25 rows | identical | **0** |
| 8 | crashes | 31 rows | — |

Row for row, with one extra column throughout — the old engine put withdrawals
and deposits in the same column, so a debit could not be told from a credit
without doing arithmetic on the balance.

---

## Where it stands

Across the corpus: **0.96 recognisable defects per 100 extracted cells**, from
1,220 rows over 68 tables, with 208 tests covering the parts that need no PDF at
all. In the browser, an eight-page statement is under three seconds, and
re-extracting after a detection pass is effectively instant.

Some things are deliberately unresolved, and we would rather say so than imply
otherwise. Nothing is joined across a page break, which is the right default but
means a description that wraps at the page bottom leaves a half-row at the top of
the next page. A scanned PDF with no text layer still produces nothing, because
there is no OCR — though the engine will now show you where it thinks the tables
are on such a page. And the machine-learning detector, which we ship as an
option, earns only three additional tables across the fifteen-document corpus
while costing about twelve megabytes of download: a poor trade for a product that
promises to work offline, and one we are still weighing.

The corpus harness is the part we would build first if we did this again. Not the
extractor — the thing that tells you whether the extractor got better. Every
change above was accepted or rejected on a diff of changed cells, and roughly a
third of the ideas that felt obviously right did not survive contact with it.
