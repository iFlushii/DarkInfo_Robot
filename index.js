const config = require("./config.json");
const phrases = require("./phrases.json");
const tariffs = require("./tariffs.json");
const { Telegraf } = require("telegraf");
const { Keyboard, Key } = require("telegram-keyboard");
let db = require("quick.db");
const fetch = require("node-fetch");
let users = new db.table("users");
const bot = new Telegraf(config.BOT_TOKEN);

const CHECKERS = {
    "phone": /^\+?[1-9]{1}[0-9]{3,14}$/giu,
    "card": /^\d{16}$/giu,
    "email": /^(([^<>()\[\]\\.,;:\s@"]+(\.[^<>()\[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/
};

bot.start(ctx => {
    if(ctx.update.message.chat.id < 0)return;
    let user_id = ctx.from.id.toString();
    let user = users.get(user_id);
    if(!user){
        user = {
            referrals: 0,
            referer: null,
            state: "MAIN_MENU",
            register_timestamp: Date.now()
        };
        users.set(user_id, user);
    }
    function processReferer(){
        let referer = ctx.startPayload;
        if(!referer || user.referer || !users.get(referer) || referer == user_id)return;
        users.set([user_id, "referer"].join("."), referer);
        let referer_u = users.get(referer);
        referer_u.referrals += 1;
        users.set(referer, referer_u);
    }
    processReferer();
    ctx.reply(phrases.START_INFO
    	.replace(/\{LINK\}/giu, `https://t.me/${config.BOT_USERNAME}?start=${user_id}`), Keyboard.make(
        Object.keys(tariffs).map(tariff => [tariff])
    ).reply());
});

bot.hears("❌ Отмена.", ctx => {
    if(ctx.update.message.chat.id < 0)return;
    let user_id = ctx.from.id.toString();
    let user = users.get(user_id);
    user.state = "MAIN_MENU";
    users.set(user_id, user);
    ctx.reply(phrases.START_INFO
    	.replace(/\{LINK\}/giu, `https://t.me/${config.BOT_USERNAME}?start=${user_id}`), Keyboard.make(
        Object.keys(tariffs).map(tariff => [tariff])
    ).reply());
});

async function getWorker(user, ctx){
    let worker = user.referer;
    if(!worker)worker = "Не определен";
    else {
        let worker_1 = (await (ctx.telegram.getChat(worker))).username;
        if(worker_1)worker = "@" + worker_1;
        else worker = (await (ctx.telegram.getChat(worker))).first_name;
    }
    return worker;
}

bot.hears("💎 Проверить оплату.", ctx => {
    if(ctx.update.message.chat.id < 0)return;
    let user_id = ctx.from.id.toString();
    let user = users.get(user_id);
    if(user.state != "PAYMENT")return;
    fetch(`https://api.qiwi.com/partner/bill/v1/bills/${user.billId}`, {
        method: "GET",
        headers: {
            Authorization: `Bearer ${config.QIWI_SECRET_KEY}`,
            Accept: "application/json"
        }
    }).then(res => res.json()).then(async res => {
        if(res.status.value == "WAITING"){
            return ctx.reply(phrases.PAYMENT_NOT_FOUND);
        }else if(res.status.value == "EXPIRED"){
            user.state = "MAIN_MENU";
            user.billId = null;
            users.set(user_id, user);
            return ctx.reply(phrases.PAYMENT_EXPIRED, Keyboard.make(
                Object.keys(tariffs).map(tariff => [tariff])
            ).reply());
        }else if(res.status.value == "PAID"){
            user.state = "MAIN_MENU";
            user.billId = null;
            users.set(user_id, user);
            ctx.reply(phrases.PAYMENT_DONE, Keyboard.make(
                Object.keys(tariffs).map(tariff => [tariff])
            ).reply());
            let worker = await getWorker(user, ctx);
            return ctx.telegram.sendMessage(Number(config.CHAT_ID), phrases.PAYMENT_RECEIVED
                .replace(/\{AMOUNT\}/giu, parseInt(res.amount.value))
                .replace(/\{WORKER\}/giu, worker));
        }
    });
});

bot.hears(/.*/giu, ctx => {
    if(ctx.update.message.chat.id < 0)return;
    let user_id = ctx.from.id.toString();
    let user = users.get(user_id);
    if(user.state == "MAIN_MENU"){
        let keys = Object.keys(tariffs);
        if(keys.includes(ctx.match[0])){
            let idx = keys.indexOf(ctx.match[0]);
            ctx.reply(phrases.SELECT_PLAN, Keyboard.make(
                Object.keys(tariffs[ctx.match[0]].plans).map((plan, i) => [Key.callback(`${plan} | ${tariffs[ctx.match[0]].plans[plan]} ₽`, `SELECT_PLAN_${idx}_${i}`)])
            ).inline());
        }
    }else if(/^SELECT_PLAN_(.*)_(.*)$/giu.test(user.state)){
        let idx = user.state.slice("SELECT_PLAN_".length).split("_")[0];
        let plidx = user.state.slice("SELECT_PLAN_".length).split("_")[1];
        if(!CHECKERS[tariffs[(Object.keys(tariffs)[idx])].checker].test(ctx.match[0]))return ctx.reply(phrases.WRONG_FORMAT);
        user.state = "PAYMENT";
        users.set(user_id, user);
        const billId = require("crypto").randomBytes(24).toString("hex")+"-"+user_id+"-"+Date.now();
        fetch(`https://api.qiwi.com/partner/bill/v1/bills/${billId}`, {
            method: "PUT",
            headers: {
                Authorization: `Bearer ${config.QIWI_SECRET_KEY}`,
                "Content-Type": "application/json",
                Accept: "application/json"
            },
            body: JSON.stringify({
                amount: {
                    value: tariffs[(Object.keys(tariffs)[idx])].plans[(Object.keys(tariffs[(Object.keys(tariffs)[idx])].plans))[plidx]],
                    currency: "RUB"
                },
                comment: "DarkInfo",
                expirationDateTime: new Date(Date.now() + (1000 * 60 * 60)).toISOString()
            })
        }).then(res => res.json()).then(res => {
            user.billId = billId;
            users.set(user_id, user);
            ctx.reply(phrases.PAYMENT_INFO
                .replace(/\{LINK\}/giu, res.payUrl), Keyboard.make([
                ["💎 Проверить оплату."],
                ["❌ Отмена."]
            ]).reply());
        });
    }
});

bot.action(/^SELECT_PLAN_(.*)_(.*)$/giu, ctx => {
    if(ctx.update.callback_query.message.chat.id < 0)return;
    let user_id = ctx.from.id.toString();
    let user = users.get(user_id);
    user.state = ctx.match[0];
    users.set(user_id, user);
    ctx.reply(tariffs[Object.keys(tariffs)[ctx.match[1]]].prompt, Keyboard.make([
        ["❌ Отмена."]
    ]).reply());
});

bot.launch();

process.on("SIGINT", () => bot.stop("SIGINT"));
process.on("SIGTERM", () => bot.stop("SIGTERM"));
