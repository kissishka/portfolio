---
title: "Пишемо читач Lisp на Rust: від тексту до дерева Value"
description: "Глибоке занурення в читач risp — Lisp-агностичний токенізатор, ітеративний парсер з явним стеком, який не може переповнитися на глибокій вкладеності, розцукрування reader-макросів, обробка крапкових пар та класифікатор атомів, що відмовляється від неоднозначних чисел замість того, щоб вгадувати."
pubDate: 2026-06-17
tags: ["rust", "lisp", "parsing"]
repo: "https://github.com/kissishka/risp"
faq:
  - q: "Що робить читач Lisp?"
    a: "Читач Lisp перетворює вихідний текст на дані. У risp він працює у два етапи: токенізатор, що розбиває текст на токени без жодного знання Lisp, і парсер, що збирає токени в дерево Value. Оскільки виходом є той самий тип Value, який виконує обчислювач, окремого AST немає."
  - q: "Як розібрати глибоко вкладений код без переповнення стеку?"
    a: "Замініть рекурсивний спуск явним стеком. Читач risp тримає Vec кадрів відкритих списків замість рекурсії на кожну відкривну дужку, тож вихідний код, вкладений на мільйон дужок, читається у сталому стеку Rust. Та сама ітеративна дисципліна керує друком і звільненням результату."
  - q: "Як цукор-цитата на кшталт 'x перетворюється на (quote x)?"
    a: "Читач трактує префіксні reader-макроси як розцукрування. Токен quote проштовхує відкладену обгортку; коли прочитано наступну повну форму, обгортки застосовуються від найвнутрішнішої, тож 'x стає (quote x), а ',x стає (quote (unquote x)). Жодного спеціального варіанта Value не потрібно."
---

Читач Lisp — це частина, що перетворює вихідний *текст* на *дані*. У
[risp](/uk/blog/building-a-lisp-in-rust-with-claude-code/) ці дані — це той самий
`Value`-дерево, на якому працює обчислювач (окремого типу AST немає), тож читач —
це ще й місце, де народжується гомоіконічність. Він працює у два етапи з різкою
межею між ними: токенізатор, що нічого не знає про Lisp, і парсер, що додає весь
сенс. Ця стаття проходить обидва.

## Токенізатор не знає Lisp

Уся робота лексера — розбити текст на плаский `Vec<Token>`. Він нічого не
класифікує: `42`, `+` і `foo` виходять усі як один і той самий `Token::Atom`, щоб
розібратися з ними пізніше. Жодних регулярних виразів; це один `match` по
`Peekable<Chars>`:

```rust
pub enum Token {
    LParen, RParen,
    Quote, Quasiquote, Unquote, UnquoteSplice,  // reader-macro sugar
    Atom(String),   // a bare lexeme to be classified later
    Str(String),    // a string literal, already unescaped
}
```

Єдині дві гілки, що потребують хоч якогось забігання наперед, — це `,@` та
екранування в рядках. Кома зазирає на один символ уперед, щоб обрати між unquote
та unquote-splicing:

```rust
',' => {
    chars.next(); // consume ','
    if chars.peek() == Some(&'@') {
        chars.next(); // consume '@'
        tokens.push(Token::UnquoteSplice);
    } else {
        tokens.push(Token::Unquote);
    }
}
```

Голий лексема читається накопиченням символів, доки щось структурне його не
завершить — пробіл, дужка, символ reader-макроса, коментар або лапки. Ця множина
термінаторів — усе уявлення лексера про те, «що розділяє токени»:

```rust
while let Some(&cc) = chars.peek() {
    if cc.is_whitespace()
        || cc == '(' || cc == ')'
        || cc == '\'' || cc == '`' || cc == ','
        || cc == ';' || cc == '"'
    {
        break;
    }
    lexeme.push(cc);
    chars.next();
}
tokens.push(Token::Atom(lexeme));
```

Зверніть увагу, що `.` немає в цій множині, тож `foo.bar` — це один атом, а
самотня `.` — це окремий атом: значення крапкової пари `.` надає читач, а не
лексер. Підтримання токенізатора настільки тупим означає, що кожне специфічне для
Lisp рішення живе рівно в одному місці нижче за течією.

## Читання — це цикл, а не рекурсивний спуск

Звичайний спосіб побудувати дерево з токенів — рекурсивний спуск: функція
`read`, що викликає себе на кожній вкладеній `(`. Але читач обробляє наданий
користувачем текст, а вихідний код може вкладатися як завгодно глибоко —
`((((…))))` глибиною в сто тисяч дужок є коректною (хай і безкорисною) програмою.
Рекурсивний спуск переповнив би на ній стек Rust. Тож читач risp, як і
[все інше, що торкається керованої користувачем глибини](/uk/blog/no-stack-overflow-lisp-interpreter-rust/),
є циклом з явним стеком. По одному `Frame` на кожен відкритий список:

```rust
struct Frame {
    items: Vec<Value>,        // elements gathered so far
    wrappers: Vec<Rc<str>>,   // reader-macro tags to apply when this list closes
    seen_dot: bool,           // dotted-pair state
    tail: Option<Value>,
}
```

`read_form` читає рівно одну повну форму, проштовхуючи кадр на `(`, виштовхуючи
його на `)` і розміщуючи кожне завершене значення в кадр під ним:

```rust
fn read_form(&mut self) -> RispResult {
    let mut frames: Vec<Frame> = Vec::new();
    let mut pending: Vec<Rc<str>> = Vec::new();

    loop {
        let Some(tok) = self.next().cloned() else {
            return Err(RispError::UnexpectedEof);   // open frame at end of input
        };
        let completed: Value = match tok {
            Token::LParen => {
                frames.push(Frame { items: Vec::new(),
                    wrappers: std::mem::take(&mut pending),
                    seen_dot: false, tail: None });
                continue;
            }
            Token::RParen => { /* pop a frame, build the list (below) */ }
            Token::Atom(a) => apply_wrappers(classify_atom(&a)?, std::mem::take(&mut pending)),
            // ... Str, the reader-macro tokens, and `.` ...
        };
        // Place `completed` into the enclosing frame, or return it if top-level.
        match frames.last_mut() {
            Some(frame) => frame.items.push(completed),
            None => return Ok(completed),
        }
    }
}
```

Оскільки ніщо не рекурсує, вихідна глибина вкладеності в мільйони читається у
сталому стеку Rust. Є тест, що будує вкладеність глибиною 100 000 у потоці з
навмисно малим стеком на 256 KiB і розбирає, рендерить *і* звільняє її — усі три
мають бути ітеративними, інакше потік помре:

```rust
let src: String = "(".repeat(depth) + &")".repeat(depth);
let v = parse_one(&src).expect("deep nest must parse");
let rendered = v.to_string(); // Display must be iterative too
drop(v);                      // and so must Drop
```

## Reader-макроси — це просто розцукрування

Префікси `'`, `` ` ``, `,`, `,@` не обробляються окремо в обчислювачі — вони
переписуються на звичайні виклики під час читання. Токен quote не породжує
значення; він проштовхує *відкладену обгортку*, що прикрашає наступну форму:

```rust
Token::Quote => { pending.push(Rc::from("quote")); continue; }
Token::Unquote => { pending.push(Rc::from("unquote")); continue; }
```

Коли прибуває наступна повна форма, `apply_wrappers` згортає ці теги навколо неї,
від найвнутрішнішого, тож складені префікси вкладаються правильно:

```rust
/// `',x` becomes `(quote (unquote x))`.
fn apply_wrappers(mut v: Value, wrappers: Vec<Rc<str>>) -> Value {
    for tag in wrappers.into_iter().rev() {
        v = Value::list(vec![Value::Symbol(tag), v]);
    }
    v
}
```

Тож `'x` читається як `(quote x)`, `` `(a ,b) `` читається як
`(quasiquote (a (unquote b)))`, а
[двигун quasiquote](/uk/blog/lisp-macros-quasiquote-rust/) пізніше розпізнає ці
розцукрувані форми суто за формою. Читачу не потрібен жоден спеціальний варіант
`Value` для жодного з них — це просто списки, чия голова є символом.

## Крапкові пари — це крихітний скінченний автомат

`(a . b)` будує єдину cons-комірку замість списку, а `(a b . rest)` будує
неправильний список. Читач обробляє це двома полями кадру — `seen_dot` і `tail`
— та кількома перевірками, що відхиляють кожну неправильну форму:

```rust
// A `.` only has dotted meaning INSIDE a list; at top level it's a symbol.
Token::Atom(ref a) if a == "." && !frames.is_empty() => {
    let frame = frames.last_mut().expect("frame present");
    if frame.items.is_empty() || frame.seen_dot || !pending.is_empty() {
        return Err(RispError::BadDottedList);   // `( . b)`, `(a . . b)`, `(a . 'b)`
    }
    frame.seen_dot = true;
    continue;
}
```

Після крапки рівно одна форма може йти перед закриттям, і вона стає хвостом
списку; друга форма, або її відсутність, — це `BadDottedList`. Хвіст `Nil`
згортається назад у правильний список, тож `(1 2 . ())` читається ідентично до
`(1 2)`. Сенс усіх цих перевірок у тому, що читач має одне визначення коректної
крапкової форми і відмовляється від усього іншого, замість того щоб збудувати
щось тонко помилкове.

## Класифікація атома: відмовляйся, не вгадуй

Щойно парсер має голий лексему, він має вирішити, *чим* той є. Порядок такий:
ціле, потім float, потім літеральні ключові слова, інакше символ:

```rust
fn classify_atom(s: &str) -> RispResult {
    if let Ok(n) = s.parse::<i64>() { return Ok(Value::Int(n)); }
    if let Ok(x) = s.parse::<f64>() {
        if !is_number_word(s) { return Ok(Value::Float(x)); }  // reject inf/nan words
    }
    match s {
        "#t" | "true"  => return Ok(Value::Bool(true)),
        "#f" | "false" => return Ok(Value::Bool(false)),
        "nil"          => return Ok(Value::Nil),
        _ => {}
    }
    if looks_numeric(s) && !is_number_word(s) {
        return Err(RispError::InvalidNumber(s.to_string()));   // `1.2.3`
    }
    Ok(Value::Symbol(Rc::from(s)))
}
```

Дві відмови тут роблять обережну роботу. По-перше, `f64::parse` радо приймає
`inf`, `nan` та `infinity`; вони читаються значно природніше як *символи*, тож
`is_number_word` відфільтровує їх назад. По-друге, і важливіше, лексема, що
*виглядає* числовою — починається з цифри, або зі знака/крапки, за якими йде
цифра, — але не парситься, є **помилкою**, а не символом:

```rust
fn looks_numeric(s: &str) -> bool {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) if c.is_ascii_digit() => true,
        Some('+' | '-' | '.') => matches!(chars.next(), Some(c) if c.is_ascii_digit() || c == '.'),
        _ => false,
    }
}
```

Тож `1.2.3` не стає мовчки символом з ім'ям `1.2.3`; це `InvalidNumber`. Це той
самий інстинкт, якому слідує
[перевірник типів JIT](/uk/blog/cranelift-jit-for-a-lisp-in-rust/): коли вхід
неоднозначний, відмовляйся голосно, а не вгадуй.

## REPL тримається на одному варіанті помилки

У читача є ще одна робота: повідомляти REPL, коли вхід *неповний*, а не
*помилковий*. Користувач, що набирає багаторядкову форму, має отримати запит на
продовження, а не помилку. risp керує цим через власний `UnexpectedEof` парсера,
а не через саморобний лічильник дужок. `parse_prefix` читає стільки повних форм,
скільки може, і повідомляє, що лишилося:

```rust
pub enum Prefix {
    Empty,                 // blank / whitespace / comment-only
    Complete(Vec<Value>),  // every token consumed into complete forms
    Incomplete(Vec<Value>),// some complete forms, then input ends mid-form
}
```

Цикл REPL відображає ці три результати прямо на поведінку: `Empty` перепитує,
`Incomplete` продовжує буферизувати ще один рядок, `Complete` обчислює кожну
форму і скидається. Справжня помилка розбору — зайва `)` — повідомляється, а
буфер очищується, тож одрук ніколи не заклинює й не аварійно завершує сесію:

```rust
match parser::parse_prefix(&buffer) {
    Ok(Prefix::Empty) => { buffer.clear(); continue; }
    Ok(Prefix::Incomplete(_)) => continue,            // ....> continuation prompt
    Ok(Prefix::Complete(forms)) => { /* eval each, then reset */ }
    Err(e) => { eprintln!("error: {e}"); buffer.clear(); }
}
```

Багаторядкове редагування, обробка вставлення та відновлення після помилки
порядково — усе це випливає з одного факту: той самий шлях коду, що будує дерево,
ще й точно знає, коли дерево ще не завершене.

Читач малий, але він задає умови для всього над ним. Його виходом є `Value`, а не
саморобний AST, і саме це дозволяє макросу бути
[звичайною функцією з коду в код](/uk/blog/lisp-macros-quasiquote-rust/). Його
форма «цикл, а не рекурсія» — це перше місце, де має виконуватися
[правило «жоден вхід не валить хост»](/uk/blog/no-stack-overflow-lisp-interpreter-rust/).
А його класифікатор «відмовляйся, не вгадуй» означає, що неправильне число
ловиться під час читання, перш ніж воно зможе видавати себе за символ на три
двигуни вглиб.
