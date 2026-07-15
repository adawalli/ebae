# eBay link exclusions

## Goal

Make each saved-search eBay link reflect its configured title exclusions.

## Behavior

`ebayWebUrl()` will parse `excludeTerms` as the poller does: comma/newline-separated entries, with surrounding whitespace removed and blank entries ignored. Each phrase becomes a quoted negative eBay keyword in `_nkw`.

For example, a search for `mac mini m4` excluding `16gb` and `256gb` opens with:

```
mac mini m4 -"16gb" -"256gb"
```

An exclusion such as `for parts` remains one negative phrase: `-"for parts"`.

## Quote constraint

eBay uses double quotes to delimit negative phrases, so request validation rejects double quotes in new or updated exclusions. Accepted phrases preserve their text after trimming. The browser link omits only quote-bearing legacy terms, preventing malformed eBay syntax without altering stored data.

## Scope

- Extend the link helper's input type to include `excludeTerms`.
- Add the negative phrases while retaining the existing marketplace, category, sort, buying-option, and price parameters.
- Add focused unit coverage for comma/newline exclusions and the no-exclusions case.

No database, poller, or UI component changes are needed; request validation changes only reject an unrepresentable eBay phrase character.
