---
title: "A Missing Header Row, and the Four Bugs Behind It"
date: 2026-09-12
author: Vijay
gravatar: 7e491724a0d1b989ddc6948e87d71d7159182eabae739da287c29f12199a4d14
twitter: '@vjyanand'
---

A bug report: a plainly ruled two-column table, converted, and the header row
simply missing. Every body row correct. The row that said what the columns were
— gone.

The fix was four separate bugs deep, each one hidden behind the last, and the
most useful thing to come out of it was not a fix at all but a way of looking.
This is the second post about the Rust engine; the [first](/posts/rebuilding-table-engine-rust)
covered the port itself.

---

## The words were never the problem

The first question with a bad extraction is always the same: did the words
arrive wrong, or did the table logic put them in the wrong place? The engine has
a flag for exactly this — `--dump-words` prints the positioned text before any
table logic has touched it — and it answered immediately. Every word of the
header was present, on the right line, at the right coordinates, at the right
font size. xpdf had done its job.

So the header row was lost somewhere in the table logic. And since the table is
ruled, that meant the ruling.

Which is where the investigation stopped, because there was no way to look at
the ruling. `--dump-words` shows the text going in and `--detect` shows the
regions coming out, but the step in between — the lines the page actually draws
— had no window onto it at all.

## Building the window first

So the first commit was a diagnostic, not a fix:

```
$ pdftab document.pdf --dump-rules
# page 1 - 2 horizontal, 69 vertical  (page 1240x1754)
  h     619.0,   227.0    546.0x62.0
  h      73.0,   227.0    544.0x62.0
  v     535.0,  1625.0      1.0x17.0
  v     156.0,   717.0      2.0x17.0
  v     143.0,   717.0      1.0x17.0
  ...
```

Two horizontal "rules", both sixty-two pixels thick and both sitting at y=227 —
which is not a line, that is the table's shaded header band. And sixty-nine
vertical "rules", every one of them two pixels wide and seventeen tall.

Those are letters. Every one of those sixty-nine was the stem of a glyph.

The table has eight horizontal rules and three verticals. The detector had found
none of them, and instead found a shaded band and a page full of letters. The
grouping stage then quite correctly refused to call any of that a table, so the
ruled source produced nothing at all — which is why a text-alignment guess had
answered instead, and why its region began below the header. The header is
centred in its cells and the body is not, so it shares no column edge with the
rows beneath it, and alignment had no reason to include it.

One symptom. Four causes.

---

## 1. Otsu cannot see a hairline on a white page

Every rule in that table is drawn at grey **193** on white. The ink threshold
came out at **164**.

The engine thresholds with Otsu's method, which is the standard choice and the
one the C++ original used too. Otsu picks the value that best separates an image
into two classes by maximising the variance between them. The reasoning for it
was sound: a scanned page and a generated one have nothing in common tonally, so
a fixed constant is wrong for one of them, and Otsu adapts.

The trouble is what it adapts *to*. A document page is about 97% paper. The
histogram is a huge spike at 255 and a small cluster down where the black text
is, and the split that maximises between-class variance lands between those two
— around 164 here. A hairline at 193 is much nearer the paper than the text, so
Otsu files it under paper, and the whole ruled grid disappears with it.

Otsu answers "where is the boundary between the two things on this page?" The
question we actually needed was "what is not paper?" — and those are only the
same question when the page has exactly two tones on it.

The threshold is now the more generous of the two readings:

```cpp
cv::Mat mask;
const double otsu = cv::threshold(grey, mask, 0, 255,
                                  cv::THRESH_BINARY_INV | cv::THRESH_OTSU);

const double below_paper = paper_level(grey) * PAPER_FRACTION;
if (below_paper > otsu) {
  cv::threshold(grey, mask, below_paper, 255, cv::THRESH_BINARY_INV);
}
```

`paper_level` is the mode of the histogram — a page is mostly paper, so the most
common grey on it *is* the paper, whether that is 255 on a generated page or
something grubbier on a scan. `PAPER_FRACTION` is 0.88, which catches a 193
hairline on white and leaves a pale row tint alone.

Otsu still wins where it should. On a dark scan, or a page with a full-bleed
background, the paper itself is dark and the second reading comes out lower, so
the original behaviour is preserved exactly.

## 2. A filled band is not a rule

With the threshold fixed, the shaded header band became visible — as a rule
sixty-two pixels thick.

A rule contributes a row boundary at its centre, and the centre of a
sixty-two-pixel band is the middle of the header text. The header row would have
been split down the middle of its own words.

In the other direction it was worse. The line-finder marks any run of ink long
enough to be a line, and every column passing through a filled band contains one
— so the band marked its entire width as vertical ink, the contour pass merged
that with the table's real verticals into a single blob, and the table came back
with no columns whatsoever.

What a filled band actually tells you is where its *edges* are, and those edges
are the table's lines: the top of the band is the top of the table, the bottom
of it is the rule under the header. So anything thicker than a rule could
plausibly be is now reported as its two edges:

```cpp
// A run thicker than `max_thickness` keeps only its first and last pixel.
if (run > max_thickness) {
  for (int back = i - run + 1; back < i - 1; ++back) {
    walk[back * stride] = 0;
  }
}
```

Runs up to that thickness are left exactly as they were. That part matters as
much as the reduction: a heavy border is a few pixels thick, and splitting one
into two rules a pixel apart would invent a row of no height between them. The
threshold works out to about ten pixels on an A4 page at 150 DPI — several times
the heaviest border anyone draws, and a small fraction of the shallowest row
anyone fills.

This generalises further than the case that prompted it. Zebra-striped rows,
shaded totals, coloured section bands: all of them are fills whose edges are
exactly where the row boundaries belong.

## 3. Reversed text punches holes in the band

A header row is usually shaded *so that* white text can sit on it. That text
punches holes clean through the filled band, and taking edges without filling
the holes first traces the top and bottom of every reversed letter.

A row of those is long enough to pass for a rule. The page grew a second,
entirely phantom table out of the outlines of the header's own white words:

```
page 1   72.0,  225.0  1094.0x524.0   confidence 0.85  rules   7 rows,  2 columns
page 1  788.0,  245.0   206.0x19.0    confidence 0.85  rules   8 rows, 31 columns
```

The second candidate is nineteen pixels tall — the height of one line of text —
and claims thirty-one columns. It did not win, but on another document it could
have.

The fix is one contour pass: fill the holes inside each marked region before
taking its edges. That would be a reckless thing to do to the ink mask, where
holes are meaningful, but this runs *after* the long-run filter, at which point
everything that is not a rule or a fill has already been erased. There is
nothing left whose holes are worth keeping.

## 4. A mark that touches a table is not one of its rules

Those sixty-nine letter stems were still there, and the same class of problem
turned up much louder elsewhere in the corpus, on a page where the ruled source
confidently reported **fifty-eight columns**.

Each one was a letter. A vertical rule needs only to be tall enough to cross a
row, and a glyph stem in a 25-point font is comfortably that; if it happens to
sit against a rule, the grouping stage takes it in, and then it contributes a
column boundary at its own centre — straight through the middle of a cell. This
is the phantom-column bug in its purest form, and it had been there all along,
harmless only because the real rules were never being found to group with.

The guard is a statement about what a rule *is*:

> A row boundary is a line across the table. A mark that merely touches one is
> not.

A line must now span at least half of its group's extent to be counted, and the
region is re-measured from the lines that survive — so a stray mark no longer
stretches the table out to reach whatever it was part of.

## The page that proves no threshold would have worked

One page of the corpus is a pie chart with no table on it anywhere, and after
the threshold change it grew an 8×20 table out of the chart's data labels and
legend.

Measuring it is the interesting part. The chart's gradient background runs from
grey 196 to white. A hairline rule is grey 193.

They are the same tone. There is no threshold — not Otsu's, not ours, not one
tuned by hand — that admits the rule and rejects the chart, because to a
histogram they are indistinguishable. Any further work on the threshold was
going to be wasted.

What separates them is geometry, not brightness: one is the width of a table and
the other is the width of a legend swatch. The span guard from the previous
section handles it for free, and the page went back to producing nothing.

That was the most useful thing the investigation turned up, and it arrived as a
false positive we had accidentally created.

---

## What the corpus said

The project's rule is that an accuracy change is not believed until it has been
measured against the fifteen-document corpus, which reports defect counts and
prints every single cell that changed. No ground truth exists, so the metric
cannot say an extraction is *right* — but it can say exactly what moved.

```
          tables:     68 ->     68
            rows:   1220 ->   1230 +10
    filled cells:   6777 ->   6871 +94
  broken numbers:     40 ->     17 -23
     ragged rows:     25 ->     30  +5
  sparse columns:      0 ->      0
    unused drawn:     33 ->     26  -7

defects per 100 cells: 0.96 -> 0.68
```

Three documents changed and twelve were byte-for-byte identical, which is the
shape you want: a targeted change that moved only what it should.

The reported document gained its header row. A second had been dropping an
entire column — every value in it lost, and every field to its right shifted one
place over — and now reads with all of its columns and all of its rows, with a
full-width section title correctly recognised as a merged row spanning the table
rather than as two phantom columns. A third gained a complete header where it had
previously been truncated to its first word.

Ragged rows went **up**, by five, and that is worth being straight about. They
are title rows and merged rows that genuinely do hold one cell out of four. The
extraction is faithful; the metric counts them as defects because it has no way
to tell a faithful sparse row from a broken one. A number that moves the wrong
way for a good reason is more useful than one quietly adjusted until it agrees
with you.

The test suite went from 213 to 220 — four in the shim for the threshold, the
band edges, the untouched thin rule and the reversed text, and three in the
grouping for the span guard and the region re-measurement.

---

## What we would take from this

**The bug you can see is rarely the bug you have.** The symptom was a missing
header row. The cause was a number in a threshold, four layers down, and each
layer only became visible once the one above it was fixed.

**Adaptive is not the same as correct.** Otsu is a good algorithm being asked a
question it does not answer. It finds the split between the two dominant tones,
and a document page has one dominant tone and a scattering of everything else.
The lesson is not "don't use Otsu" — it is still in there, and it still wins on
scans — but to know which question a method answers before trusting it with a
different one.

**When a measurement can't distinguish two things, stop measuring harder.** The
chart and the hairline are the same grey. That is not a tuning problem, and an
afternoon could have gone into the threshold before noticing.

**Build the window before you look through it.** `--dump-rules` took twenty
minutes and none of the four bugs was visible without it. It is now a permanent
part of the tool, sitting between `--dump-words` and `--detect`, and it is the
first thing we will reach for the next time a ruled table comes out wrong.

The engine is browser-only and offline, as it has always been: your PDF is never
uploaded, and all of the above runs in a Web Worker on your own machine.
