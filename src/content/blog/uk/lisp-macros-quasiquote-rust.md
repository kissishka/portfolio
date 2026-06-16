---
title: "Макроси та quasiquote: код, що пише код у risp"
description: "Детальний розбір системи макросів risp на Rust: як defmacro, розгортання за вимогою, рушій quasiquote та gensym дають Lisp вирощувати керівні конструкції на кшталт while та unless, які не виразити жодною функцією."
pubDate: 2026-06-10
tags: ["lisp", "macros", "interpreters"]
faq:
  - q: "Чому макроси Lisp не можуть бути звичайними функціями?"
    a: "Функція обчислює всі свої аргументи перед тим, як виконається її тіло, тож вона не може вирішувати, чи виконувати код, і не може винаходити нові керівні конструкції. Записаний як функція, вираз (unless cold (wear-coat)) завжди викликав би wear-coat. Макроси перетворюють код до обчислення, тому вони можуть додавати керівні конструкції на кшталт while та unless."
  - q: "Що таке quasiquote у Lisp?"
    a: "Quasiquote (квазіцитування) — це шаблонна мова для побудови коду. Зворотна лапка цитує структуру буквально, кома (unquote) вставляє обчислене значення в дірку, а кома-ет (unquote-splicing) вклеює елементи списку в позицію, що й робить можливими варіативні макроси."
  - q: "Що таке gensym і навіщо він потрібен?"
    a: "gensym генерує унікальний символ, який не може зіткнутися з іменами користувача. gensym-и в risp мають вигляд {g 0}, з пробілом усередині фігурних дужок, який reader ніколи не зможе утворити з вихідного коду, тож тимчасові змінні макроса структурно нездатні захоплювати чи затіняти змінні викликача."
---

Деякі речі не можуть бути функціями. `unless` — класичний приклад: функція
обчислює всі свої аргументи перед тим, як виконається її тіло, тож вираз
`(unless cold (wear-coat))` викликав би `wear-coat` беззастережно. Щоб вирішувати,
чи взагалі виконувати код, або щоб винайти керівну конструкцію, якої мова ніколи
не постачала, потрібно перетворити код до того, як він буде обчислений. Саме це й
роблять макроси, а в [risp](/uk/blog/building-a-lisp-in-rust-with-claude-code/)
весь механізм — це кілька сотень рядків Rust поверх того самого дерева `Value`,
яке утворює reader. Цей допис заглядає під капот.

## Макрос — це замикання, що працює над кодом

На рівні користувача `defmacro` виглядає геть як визначення функції, тільки
параметри прив'язуються до необчисленого коду:

```lisp
(defmacro unless (test body)
  `(if ,test () ,body))

(unless #f 'ran)                     ; => ran
(macroexpand '(unless cold (coat)))  ; => (if cold () (coat))
```

Усередині інтерпретатора макрос структурно ідентичний замиканню (ті самі
параметри, те саме тіло, те саме захоплене середовище), але загорнутий в окремий
варіант `Value::Macro`, щоб обчислювач міг їх розрізняти:

```rust
// src/specials.rs
pub fn make_macro(args: &[Value], env: &Env) -> Result<Value, RispError> {
    if args.len() < 3 {
        return Err(RispError::bad_form(
            "defmacro",
            "expects (defmacro name (params) body...)",
        ));
    }
    let name = args[0]
        .as_sym()
        .map_err(|_| RispError::bad_form("defmacro", "name must be a symbol"))?
        .clone();
    let (params, rest) = parse_params("defmacro", &args[1])?;
    let body: Vec<Value> = args[2..].to_vec();

    let closure = Closure {
        name: Some(name.clone()),
        params,
        rest,
        body: Rc::new(body),
        env: env.clone(),
    };
    let macro_val = Value::Macro(Rc::new(closure));
    env.borrow_mut().define(name, macro_val.clone());
    Ok(macro_val)
}
```

Єдине, що відрізняє макрос від lambda, — це тег `Value::Macro`. Усе цікаве
відбувається пізніше, коли обчислювач натрапляє на місце виклику, оператор якого
прив'язаний до макроса.

## Розгортання відбувається за вимогою, а не окремим проходом

Багато Lisp-ів виконують окремий прохід розгортання макросів над усією програмою
перед обчисленням. risp так не робить. Його обчислювач — це машина з явним стеком
(той самий [ітеративний дизайн, що тримає глибоку рекурсію осторонь від стека
Rust](/uk/blog/no-stack-overflow-lisp-interpreter-rust/)), і розгортання макросів
відбувається всередині самого кроку обчислення, за вимогою:

```rust
// src/eval.rs — step_eval
Value::Pair(ref p) => {
    let head = p.car.clone();
    let rest = p.cdr.clone();
    if let Value::Symbol(sym) = &head {
        // Special-form dispatch happens BEFORE argument evaluation.
        if is_special(sym) {
            let args = rest.list_vec()?;
            return eval_special(sym, args, env, stack);
        }
        // A macro use expands (on UNEVALUATED operands) and the result
        // is evaluated in its place.
        if let Some(mac) = macro_lookup(sym, &env) {
            let operands = rest.list_vec()?;
            let expansion = expand_once(&mac, operands)?;
            return Ok(St::Eval(expansion, env));
        }
    }
    // Ordinary application: evaluate the operator, then the operands.
    let operands = rest.list_vec()?;
    stack.push(Frame::App { pending: operands, vals: Vec::new(), env: env.clone() });
    Ok(St::Eval(head, env))
}
```

Порядок перевірок має значення: **спеціальна форма, потім макрос, потім звичайне
застосування.** Коли head є макросом, risp передає форми операндів сирими — як
дерева `Value`, код-як-дані — у тіло макроса, виконує його й подає результат прямо
назад у машину через `St::Eval(expansion, env)`. Розгортання заходить повторно, як
будь-який інший вираз, і якщо воно розгортається в інший виклик макроса, наступна
ітерація циклу обробить і його. Розгортання — це просто обчислення, яке так
сталося, що утворює код, а не значення:

```rust
// src/eval.rs
pub fn expand_once(mac: &Closure, operands: Vec<Value>) -> RispResult {
    let frame = child(&mac.env);
    bind_params(mac, &operands, &frame)?;
    eval_seq(&mac.body, &frame)
}
```

## Quasiquote: побудова коду з шаблону

Писати розгортання вручну за допомогою `cons` та `list` нечитабельно. Quasiquote —
це шаблонна мова, що це виправляє: зворотна лапка `` ` `` цитує структуру буквально,
`,` (unquote) вставляє обчислене значення в дірку, а `,@` (unquote-splicing)
вставляє елементи списку в дірку. Саме останнє робить можливими варіативні макроси:
`. body` захоплює решту аргументів, а `,@body` вклеює їх у `begin`:

```lisp
(defmacro when (test . body)
  `(if ,test (begin ,@body) ()))
```

Рушій за цим — це один рекурсивний обхід шаблону, параметризований глибиною
unquote, щоб вкладені quasiquote поводилися коректно:

```rust
// src/specials.rs
pub fn quasi(template: &Value, depth: usize, env: &Env) -> Result<Value, RispError> {
    // Atoms are literal.
    if !matches!(template, Value::Pair(_)) {
        return Ok(template.clone());
    }
    // `,x` — fire at depth 1, otherwise peel one level and rebuild.
    if let Some(inner) = tagged(template, "unquote") {
        return if depth == 1 {
            eval(&inner, env)
        } else {
            Ok(retag("unquote", quasi(&inner, depth - 1, env)?))
        };
    }
    // Nested `` `x `` raises the depth.
    if let Some(inner) = tagged(template, "quasiquote") {
        return Ok(retag("quasiquote", quasi(&inner, depth + 1, env)?));
    }
    // A general list: walk the spine, handling `,@x` in element position.
    let mut out: Vec<Value> = Vec::new();
    let mut cur = template.clone();
    loop {
        match cur {
            Value::Pair(p) => {
                let car = p.car.clone();
                if let Some(inner) = tagged(&car, "unquote-splicing") {
                    if depth == 1 {
                        let spliced = eval(&inner, env)?;
                        let elems = spliced.list_vec().map_err(|_| {
                            RispError::bad_form("quasiquote", "unquote-splicing expects a list")
                        })?;
                        out.extend(elems);          // <-- the splice
                    } else {
                        out.push(retag("unquote-splicing", quasi(&inner, depth - 1, env)?));
                    }
                } else {
                    out.push(quasi(&car, depth, env)?);
                }
                cur = p.cdr.clone();
            }
            Value::Nil => return Ok(Value::list(out)),
            other => return Ok(Value::list_with_tail(out, quasi(&other, depth, env)?)),
        }
    }
}
```

(Я скоротив граничні випадки з крапковим хвостом, коли `,x` чи `,@x` сидить у
хвостовій позиції неправильного списку, але форма саме така.) Цікаві моменти:

- **Атом є буквальним**: `` `5 `` — це просто `5`. Лише `Pair`-и потребують
  роботи.
- **`,x` на глибині 1 негайно викликає `eval`**, підставляючи живе значення часу
  виконання в дерево коду, що будується. Це і є місток між обчисленням під час
  розгортання та кодом, який воно випромінює.
- **`,@x` на глибині 1 обчислює `x`, вимагає список і `out.extend(elems)`**,
  розплющуючи змінну кількість форм в одну позицію. Це єдиний спосіб вклеїти
  список інструкцій в один слот коду.
- **Вкладені quasiquote підвищують глибину**; unquote-и спрацьовують лише на
  глибині 1, тож внутрішній `` `(... ,x) `` зберігає свій `,x` для внутрішнього
  рівня. Помічник `tagged` розпізнає десагарені reader-ом форми
  `(unquote x)` / `(unquote-splicing x)` суто за формою, без потреби в окремому
  варіанті `Value`.

`quasi` — це також єдине місце, де risp рекурсує на стеку Rust пропорційно до
глибини вихідного коду (один кадр на кожен рівень вкладеності quasiquote), і це
нормально, бо вкладеність шаблону обмежена текстом програми, а не даними часу
виконання.

## gensym: імена, які неможливо захопити

Макроси risp **негігієнічні за замовчуванням**: розгортання потрапляє в область
видимості викликача, тож будь-яке тимчасове ім'я, яке вводить макрос, може
зіткнутися зі змінною (чи затінити її), яку передав викликач. `swap!` — це
підручникова небезпека, бо йому потрібна тимчасова змінна:

```lisp
(defmacro swap! (a b)
  (let ((g (gensym)))
    `(let ((,g ,a)) (set! ,a ,b) (set! ,b ,g))))
```

`gensym` — це аварійний вихід, і його реалізація — це акуратний трюк:

```rust
// src/builtins.rs
fn b_gensym(args: &[Value]) -> RispResult {
    if args.len() > 1 {
        return Err(RispError::arity("gensym", "0 or 1", args.len()));
    }
    let prefix = match args.first() {
        None => "g".to_string(),
        Some(Value::Str(s)) => s.to_string(),
        Some(Value::Symbol(s)) => s.to_string(),
        Some(other) => return Err(RispError::type_error("gensym", "string or symbol", other)),
    };
    let n = GENSYM_COUNTER.with(|c| {
        let v = c.get();
        c.set(v.wrapping_add(1));
        v
    });
    Ok(Value::Symbol(Rc::from(format!("{{{prefix} {n}}}"))))
}
```

Згенероване ім'я має вигляд `{g 0}`, `{g 1}`, …, і воно містить **пробіл усередині
фігурних дужок, шаблон, який reader risp ніколи не зможе утворити з тексту
вихідного коду.** Тож gensym структурно нездатний зіткнутися з жодним
ідентифікатором, який міг би набрати програміст, а монотонний лічильник тримає
послідовні gensym-и відмінними один від одного. Гігієна за побудовою, за вибором,
без жодної машинерії `syntax-rules`.

## macroexpand: побачити рівно те, що ви написали

Оскільки макрос — це «просто» функція з коду в код, ви можете попросити risp
показати вам код, який вона утворює, не виконуючи його:

```rust
// src/eval.rs
pub fn macroexpand_full(mut form: Value, env: &Env) -> RispResult {
    loop {
        let (head, rest) = match &form {
            Value::Pair(p) => (p.car.clone(), p.cdr.clone()),
            _ => return Ok(form),
        };
        let Value::Symbol(sym) = &head else { return Ok(form); };
        if is_special(sym) { return Ok(form); }
        match macro_lookup(sym, env) {
            Some(mac) => { let operands = rest.list_vec()?; form = expand_once(&mac, operands)?; }
            None => return Ok(form),
        }
    }
}
```

Воно циклить `expand_once`, доки head перестане бути макросом, а потім повертає
вільну від макросів форму необчисленою. Воно розгортає лише верхній рівень
(стандартний `macroexpand`, а не `macroexpand-all`), що саме те, чого ви хочете
при налагодженні окремого макроса.

## Винагорода: цикл, якого в мові немає

У risp немає `while`. Тож ви пишете його самі — з `defmacro`, quasiquote та
gensym-гігієнічного помічника:

```lisp
(defmacro while (test body)
  (let ((loop (gensym)))
    `(begin
       (def ,loop (lambda () (if ,test (begin ,body (,loop)) 0)))
       (,loop))))

(while (< i 1000000)
  (begin (set! total (+ total i))
         (set! i (+ i 1))))
```

Під час розгортання `loop` прив'язується до свіжого `{g 0}`; потім шаблон вклеює
gensym як ім'я визначення й вставляє дерева `,test` та `,body` викликача в `if`.
Місце виклику розгортається, один раз перед обчисленням, приблизно в:

```lisp
(begin
  (def {g 0} (lambda () (if (< i 1000000) (begin <body> ({g 0})) 0)))
  ({g 0}))
```

Три речі роблять це робочим і безкоштовним:

1. **Ім'я помічника неможливо захопити:** `{g 0}` нечитабельне, тож `def`, який
   воно вводить, невидиме для області видимості викликача.
2. **Рекурсія є хвостовим викликом:** `({g 0})` сидить у хвостовій позиції, тож
   обчислювач risp виконує його в [сталому стеку для будь-якої кількості
   ітерацій](/uk/blog/no-stack-overflow-lisp-interpreter-rust/). Мільйон ітерацій
   не вирощує стек.
3. **Воно зникає до часу виконання:** макрос щезає при розгортанні; виконується
   звичайна хвостово-рекурсивна функція.

У Python еквівалента немає: ви не можете додати нову керівну конструкцію в Python
зсередини Python. Навіть власні `map`, `filter` та `fold` risp живуть у
[прелюдії на рівні risp](/uk/blog/building-a-lisp-in-rust-with-claude-code/), а не
в Rust, зі спорідненої причини: щоб тримати їхню рекурсію на купному стеку
обчислювача, а не на стеку хоста.

Ось у чому привабливість гомоіконічного коду: оскільки програма — це просто дерево
`Value`, макрос є звичайною функцією, яка так сталося, що виконується під час
розгортання й повертає ще дерево. Мова розширювана зсередини, а розширення
неможливо відрізнити від вбудованого, щойно воно розгорнулося.
