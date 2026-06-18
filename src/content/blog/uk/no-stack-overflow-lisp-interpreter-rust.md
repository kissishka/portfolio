---
title: "Проєктування інтерпретатора Lisp на Rust без переповнень стеку"
description: "Глибоке занурення в ітеративне ядро risp: enum Value, написаний вручну ітеративний Drop та обчислювач CEK з явним стеком, які читають, друкують, порівнюють, звільняють і обчислюють структуру глибиною в мільйон без переповнення стеку Rust."
pubDate: 2026-06-11
tags: ["rust", "interpreters", "lisp"]
repo: "https://github.com/kissishka/risp"
faq:
  - q: "Як зупинити деревообхідний інтерпретатор (tree-walker) від переповнення стеку?"
    a: "Перетворіть кожен рекурсивний обхід даних користувача на цикл із явним стеком. risp використовує ітеративний обчислювач CEK, написаний вручну ітеративний Drop, а також друк і перевірку рівності на основі циклів, тож стек викликів Rust залишається завглибшки в кілька кадрів, хоч би якою глибокою була вхідна структура."
  - q: "Чому звільнення довгого зв'язаного списку переповнює стек у Rust?"
    a: "Cons-комірки за Rc отримують рекурсивний деструктор: звільнення однієї Pair звільняє її cdr, що звільняє наступну, і так далі. Звільнення списку з 500 000 елементів рекурсує на глибину 500 000 кадрів. risp замінює похідний Drop на ітеративний teardown, який переміщує дочірні елементи на робочий стек у купі."
  - q: "Що таке машина CEK?"
    a: "Машина CEK обчислює вирази за допомогою явного керувального регістра та стека кадрів продовження (continuation) у купі замість рекурсії хоста. Обчислювач risp — це один цикл по (St, Vec<Frame>), тож хвостові виклики виконуються в сталому просторі, а нехвостова рекурсія глибиною в мільйон нарощує вектор у купі, а не стек викликів Rust."
---

Інтерпретатор Lisp — це здебільшого рекурсія по деревах, а рекурсія по
наданих користувачем деревах — це переповнення стеку, яке тільки й чекає нагоди.
Проєктне правило, що стоїть за
[risp](/uk/blog/building-a-lisp-in-rust-with-claude-code/), було безапеляційним: **жоден
вхід ніколи не повинен аварійно завершувати роботу хоста.** Ні список на мільйон елементів, ні рекурсія глибиною в
мільйон, ні глибоко вкладений літерал. Це єдине правило сформувало все ядро, і
виявляється, що захищати його доводиться у п'яти різних місцях.

## Один enum — це і програма, і дані

risp гомоіконічний за побудовою: єдиний enum `Value` є і розібраним AST, *і*
значенням під час виконання.

```rust
/// The one enum that is both AST and runtime value.
#[derive(Clone, Debug)]
pub enum Value {
    Nil,
    Bool(bool),
    Int(i64),
    Float(f64),
    Str(Rc<str>),
    Symbol(Rc<str>),
    /// A cons cell: the building block of lists AND of program forms.
    Pair(Rc<Pair>),
    Builtin(Rc<Builtin>),
    Closure(Rc<Closure>),
    /// A macro: like a closure, but invoked on its UNEVALUATED arguments.
    Macro(Rc<Closure>),
    Compiled(Rc<ClosureObj>),
}

pub struct Pair {
    pub car: Value,
    pub cdr: Value,
}
```

Коли читач розбирає `(+ 1 2)`, він видає `Value::Pair`, чий `car` —
`Value::Symbol("+")`, а чий `cdr` — це ланцюжок із інших пар; обчислювач
оперує саме цією структурою без окремого типу AST. Кожен вантаж у купі
лежить за `Rc`, тож `Value: Clone` завжди має складність O(1): клонування `Pair`
збільшує один лічильник посилань, воно не копіює список. А оскільки `Pair` — це
просто два слоти `Value`, `car`/`cdr`/`cons` є операціями над полями зі складністю O(1). Зверніть увагу, що
`Macro` повторно використовує `Rc<Closure>`: макрос структурно є замиканням із іншим
тегом enum, і [цей тег — це і є вся макросистема](/uk/blog/lisp-macros-quasiquote-rust/).

## Прихована небезпека: звільнення довгого списку

Ось пастка, у яку потрапляють усі. Cons-комірки за `Rc` безкоштовно отримують рекурсивний
деструктор: звільнення `Pair` звільняє її `cdr`, що звільняє `cdr` наступної
`Pair`, і так далі. Звільніть список завдовжки 500 000 елементів, і ось вам
рекурсія на 500 000 кадрів у стеку викликів Rust: миттєве переповнення. risp замінює
похідний деструктор написаним вручну ітеративним:

```rust
impl Drop for Pair {
    fn drop(&mut self) {
        // Seed the shared iterative teardown with this cell's two slots so a long
        // `cdr` spine or deep `car` nest is reclaimed without recursing.
        dismantle(vec![
            Teardown::Val(std::mem::replace(&mut self.car, Value::Nil)),
            Teardown::Val(std::mem::replace(&mut self.cdr, Value::Nil)),
        ]);
    }
}
```

Хитрість у `mem::replace`: замість того, щоб дати полям звільнятися на місці (що
призвело б до рекурсії), він переміщує їх назовні, залишаючи позаду нешкідливі `Nil`, і передає
їх у цикл:

```rust
pub(crate) fn dismantle(mut stack: Vec<Teardown>) {
    while let Some(item) = stack.pop() {
        match item {
            Teardown::Val(Value::Pair(rc)) => {
                if let Ok(mut p) = Rc::try_unwrap(rc) {
                    stack.push(Teardown::Val(std::mem::replace(&mut p.car, Value::Nil)));
                    stack.push(Teardown::Val(std::mem::replace(&mut p.cdr, Value::Nil)));
                }
            }
            Teardown::Val(Value::Closure(rc)) | Teardown::Val(Value::Macro(rc)) => {
                if let Ok(c) = Rc::try_unwrap(rc) {
                    let Closure { env, .. } = c;
                    stack.push(Teardown::Env(env));   // closures capture scopes too
                }
            }
            Teardown::Val(_) => {}
            Teardown::Env(e) => {
                if let Ok(cell) = Rc::try_unwrap(e) {
                    let mut env = cell.into_inner();
                    let (parent, vals) = env.take_children();
                    if let Some(p) = parent { stack.push(Teardown::Env(p)); }
                    stack.extend(vals.into_iter().map(Teardown::Val));
                }
            }
        }
    }
}
```

Це класичний обхід графа з явним стеком. Ключовий хід: дочірні елементи вузла
проштовхуються на робочий стек у купі, перш ніж звільниться сам вузол, тож його власний `Drop`
завжди знаходить порожні слоти `Nil` і повертається за O(1). Жоден ланцюжок не може рекурсувати.
`Rc::try_unwrap` — це те, що робить процес безпечним зі спільною структурою: він спускається в
комірку лише тоді, коли цей власник останній, а ще спільна комірка залишається своєму
останньому власнику, щоб той звільнив її пізніше. Enum `Teardown` об'єднує дві небезпеки в один
робочий стек: довгі ланцюжки `Value` та глибокі ланцюжки областей видимості, захоплені замиканнями,
тож звільнення замикання, яке закрилося над тисячею вкладених кадрів `let`, так само
пласке. Є тест, який будує структури глибиною 200 000 у потоці зі
стеком на 256 KiB і звільняє їх; рекурсивний `Drop` миттєво підірвав би це.

## Обчислення — це цикл, а не рекурсія

Той самий принцип керує обчисленням. Обчислювач risp — це машина CEK з явним
стеком: керувальний регістр з двома варіантами та стек кадрів продовження
(continuation) у купі.

```rust
/// The machine's control register: an expression to evaluate, or a value
/// being handed back to the top continuation.
enum St {
    Eval(Value, Env),
    Ret(Value),
}

enum Frame {
    App  { pending: Vec<Value>, vals: Vec<Value>, env: Env },
    Seq  { rest: Vec<Value>, env: Env },
    If   { conseq: Value, alt: Option<Value>, env: Env },
    Let  { names: Vec<Rc<str>>, pending: Vec<Value>, vals: Vec<Value>, body: Vec<Value>, env: Env },
    And  { rest: Vec<Value>, env: Env },
    // ... Def, Set, Or, Cond, MacroExpand
}
```

Увесь обчислювач — це один цикл, який чергує два варіанти:

```rust
/// The single drive loop: alternately evaluate an expression or feed a value to
/// the top frame, until the frame stack empties.
fn run_loop(mut st: St, mut stack: Vec<Frame>) -> RispResult {
    loop {
        st = match st {
            St::Eval(expr, env) => step_eval(expr, env, &mut stack)?,
            St::Ret(val) => match stack.pop() {
                None => return Ok(val),
                Some(frame) => step_return(frame, val, &mut stack)?,
            },
        };
    }
}
```

Увесь стан обчислювача в будь-який момент — це `(St, Vec<Frame>)`. Стек викликів Rust
залишається завглибшки в три кадри (`run_loop` → `step_eval`/`step_return`), хоч би
якою глибокою була програма.

### Хвостові виклики у сталому просторі

Коли застосовується замикання, `apply_value` не рекурсує: він повертає тіло як
наступний `St::Eval`:

```rust
fn apply_value(callable: Value, args: Vec<Value>, stack: &mut Vec<Frame>) -> Result<St, RispError> {
    match callable {
        Value::Builtin(b) => (b.func)(&args).map(St::Ret),
        Value::Closure(c) => {
            let frame = child(&c.env);
            bind_params(&c, &args, &frame)?;
            // Fast path for the common single-form body: tail-evaluate it.
            if c.body.len() == 1 {
                Ok(St::Eval(c.body[0].clone(), frame))
            } else {
                Ok(begin_sequence(c.body.to_vec(), frame, stack))
            }
        }
        other => Err(RispError::NotCallable(other.to_string())),
    }
}
```

`run_loop` просто перепризначає `st` і продовжує. Якщо останній вираз тіла — це
ще один виклик, `step_eval` проштовхує один `Frame::App`, розв'язує його і викликає
`apply_value` знову, який знову повертає `St::Eval`. Хвостоворекурсивна функція
замінює поточне обчислення, а не нагромаджується поверх нього, тож `Vec<Frame>` у
купі залишається завглибшки O(1) для будь-якої кількості ітерацій. `Frame::Seq` робить це
автоматичним: остання форма будь-якого тіла входить із голим `St::Eval` і без нового
кадру, тож вона завжди в належній хвостовій позиції.

### Нехвостова вкладеність нарощує купу, а не стек

А як щодо справді нехвостової рекурсії, як-от `(+ 1 (+ 1 (+ 1 …)))` глибиною в
мільйон? Обчислення зовнішнього `+` проштовхує `Frame::App` у `Vec` купи і
переходить до внутрішнього виклику, який проштовхує наступний, і так далі. Мільйон вкладених викликів
породжує мільйон записів `Frame::App` у векторі купи, який може вирости до
гігабайтів, тоді як стек викликів Rust, обмежений кількома мегабайтами, не росте
взагалі. Тож це повертає відповідь там, де CPython піднімає `RecursionError` на глибині
~1000:

```lisp
(def sum-to (lambda (n acc) (if (= n 0) acc (sum-to (- n 1) (+ acc n)))))
(sum-to 1000000 0)   ; => 500000500000
```

## Усе, що торкається даних користувача, є ітеративним

Щойно ви дотримуєтесь цього правила, воно має виконуватися всюди, інакше найслабший
обхід стає аварією. Тож структурна рівність виконується на явному
робочому стеку з множиною відвіданих вузлів, яка ще й згортає спільні DAG до лінійного часу:

```rust
pub fn risp_equal(a: &Value, b: &Value) -> bool {
    let mut work: Vec<(Value, Value)> = vec![(a.clone(), b.clone())];
    let mut visited: HashSet<(usize, usize)> = HashSet::new();
    while let Some((p, q)) = work.pop() {
        match (&p, &q) {
            (Value::Pair(x), Value::Pair(y)) => {
                if Rc::ptr_eq(x, y) { continue; }
                let key = (Rc::as_ptr(x) as usize, Rc::as_ptr(y) as usize);
                if !visited.insert(key) { continue; }
                work.push((x.car.clone(), y.car.clone()));
                work.push((x.cdr.clone(), y.cdr.clone()));
            }
            _ => { if !risp_eq(&p, &q) { return false; } }
        }
    }
    true
}
```

Те саме стосується і друку: `Display` чергує на стеку кроки «відрендерити це підзначення» та
«вивести цей літеральний токен», розкручуючи хребет списку в щільному внутрішньому циклі,
тож плаский список на 500 000 елементів друкується без зростання стеку:

```rust
enum Step { Render(Value), Raw(&'static str) }
let mut stack = vec![Step::Render(self.clone())];
while let Some(step) = stack.pop() {
    match step {
        Step::Raw(s) => f.write_str(s)?,
        Step::Render(v) if matches!(v, Value::Pair(_)) => {
            // unwind the cdr-spine into `seq`, pushed in reverse so it pops in order
            // ... then: stack.extend(seq.into_iter().rev());
        }
        Step::Render(atom) => write_atom(f, &atom)?,
    }
}
```

Те саме стосується і матеріалізації списку аргументів виклику (`list_vec`, щільний цикл `cur =
p.cdr.clone()`), і обходу ланцюжка областей видимості для змінної. Читання,
друк, структурна рівність, звільнення пам'яті та обчислення — усе є ітеративним.
Єдина звичайна рекурсія, що лишилася в усьому інтерпретаторі, обмежена
вихідним текстом, а не даними під час виконання: глибина вкладеності шаблона quasiquote.

## Єдина ціна: пошук змінної

Ітеративна безпека не безкоштовна. Середовище — це `HashMap` на кожну область видимості плюс
вказівник на батьківську, а пошук обходить ланцюжок:

```rust
pub fn lookup(env: &Env, name: &str) -> Option<Value> {
    let mut cursor = env.clone();
    loop {
        let next = {
            let frame = cursor.borrow();
            if let Some(v) = frame.vars.get(name) { return Some(v.clone()); }
            frame.parent.clone()
        };
        match next {
            Some(parent) => cursor = parent,
            None => return None,
        }
    }
}
```

Ітеративний, тож глибокий ланцюжок областей видимості коштує ітерацій у купі, а не кадрів стеку, але
кожен крок — це хешування рядка та зондування `HashMap`. Для деревообхідного інтерпретатора це
гарний компроміс. Це також найбільший розрив у продуктивності між наївним інтерпретатором
і швидким, а усунення цього розриву (розв'язання кожної змінної до індексу масиву
під час компіляції) — це саме те, що робить [байткод-VM
risp](/uk/blog/bytecode-vm-faster-than-cpython/), щоб лишити деревообхідний інтерпретатор (і
CPython) позаду.

Урок узагальнюється поза межами Lisp. У будь-якому інтерпретаторі кожен рекурсивний обхід
керованих користувачем даних — це прихована аварія, яка проявляється лише на тому вході, який ви не
протестували. Перетворіть кожен на цикл, і питання «наскільки глибоким може бути вхід?»
перестане бути тим, чого варто боятися. Ця дисципліна, не випадково, є також тим, що робить
безпечним будівництво [агресивних швидких шляхів `unsafe` та нативного
JIT](/uk/blog/cranelift-jit-for-a-lisp-in-rust/) поверх ядра, якому можна довіряти.
