# gotcha

A non-obvious pitfall or trap, learned the hard way.

## Source line wrapping in the feature panel

What: The shared source line (`srcLine`, `.srcline`) must not use `white-space: nowrap` on its labels; labels break with `overflow-wrap: anywhere`, the arrow is glued with `&nbsp;↗`, while read times and the compact "source ↗" only wrap between words, and the sources-table cell keeps a 14ch minimum · Why: a nowrap link label ("blocking feature …") overflowed the red "Waiting on…" callout even though the callout itself had `overflow-wrap: anywhere`; but `anywhere` everywhere let auto-layout tables squeeze the source column and split short words mid-word · Where: public/styles.css (.srcline rules), public/app.js srcLine · Learned: a container's overflow-wrap is useless if a child sets nowrap; and `anywhere` shrinks min-content, so in tables/flex rows give short items `overflow-wrap: normal` or a min-width
