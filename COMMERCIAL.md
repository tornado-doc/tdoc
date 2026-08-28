# Commercial licensing

tdoc is AGPL v3. For most people that is the end of it: use it, change it,
run it, share it.

## When the AGPL does not work for you

The AGPL's distinguishing clause is section 13. If you modify tdoc and let
other people use it **over a network**, those users are entitled to your
modified source — running it as a service counts as distribution, where most
open-source licences only trigger on shipping a binary.

That is deliberate. It is also the wrong shape for some products:

- embedding tdoc inside a closed-source application you ship or sell
- running a modified tdoc as part of a hosted product without publishing
  the modifications
- a company policy that rules out copyleft dependencies

A commercial licence covers those. It grants the same code under terms that
do not require you to publish your changes.

## Getting one

Open an issue at https://github.com/tornado-doc/tdoc/issues, or contact
[@serenakeyitan](https://github.com/serenakeyitan). Say roughly what you are
building and how tdoc fits; terms are worked out case by case.

Asking costs nothing and the answer is often that you did not need one — the
AGPL is only triggered by *modifying* tdoc and serving it. Running tdoc
unmodified, or publishing documents it produced, does not put you in that
position.

## What a commercial licence does not cover

Third-party code vendored in this repository keeps its own terms and is not
ours to relicense:

| Path | Licence | Holder |
|---|---|---|
| `authoring/vendor/no-ai-slop.md` | MIT | Peter Yang |

Documents you write with tdoc are yours. The licence is on tdoc itself, not
on its output.
