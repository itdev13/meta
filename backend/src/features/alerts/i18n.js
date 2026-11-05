/**
 * Alert copy per language. {account} = sub-account name, {number} = "WhatsApp #2 (+1 512…)".
 * Reasons: logged_out | banned | replaced | disconnected.
 */
const STRINGS = {
  en: {
    name: 'English',
    subject: {
      down: '⚠️ {number} is disconnected · {account}',
      reminder: 'Still disconnected: {number} · {account}',
      back: '✅ {number} is back online · {account}',
      test: 'Test alert · {account}',
    },
    title: { down: 'A WhatsApp number disconnected', reminder: 'A WhatsApp number is still disconnected', back: 'Your WhatsApp number is back online', test: 'Alerts are working' },
    reason: {
      logged_out: 'It was unlinked from the phone (Linked devices → Log out).',
      banned: 'WhatsApp restricted this number.',
      replaced: 'Another WhatsApp Web or Desktop session took over this number.',
      disconnected: 'The connection dropped and hasn’t come back.',
    },
    fix: {
      logged_out: 'Open WhatsApp in the sub-account’s left menu, find the number and click Link again, then scan the QR code.',
      banned: 'Open WhatsApp on the phone to see WhatsApp’s notice. You may need to request a review before linking it again.',
      replaced: 'Close other WhatsApp Web or Desktop sessions for this number, then click Reconnect on the number.',
      disconnected: 'We keep retrying automatically. Make sure the phone is switched on and has internet. If it stays down, click Reconnect.',
    },
    impact: 'Messages on this number won’t reach the CRM until it’s reconnected.',
    backBody: 'Messages are syncing to the CRM again.',
    testBody: 'This is a test. You’ll get an alert like this when a number disconnects.',
    labels: { account: 'Sub-account', number: 'Number', since: 'Since', fix: 'What to do' },
    footer: 'You get this because you’re listed for WhatsApp alerts on this sub-account.',
  },
  es: {
    name: 'Español',
    subject: {
      down: '⚠️ {number} está desconectado · {account}',
      reminder: 'Sigue desconectado: {number} · {account}',
      back: '✅ {number} vuelve a estar en línea · {account}',
      test: 'Alerta de prueba · {account}',
    },
    title: { down: 'Un número de WhatsApp se desconectó', reminder: 'Un número de WhatsApp sigue desconectado', back: 'Tu número de WhatsApp vuelve a estar en línea', test: 'Las alertas funcionan' },
    reason: {
      logged_out: 'Se desvinculó desde el teléfono (Dispositivos vinculados → Cerrar sesión).',
      banned: 'WhatsApp restringió este número.',
      replaced: 'Otra sesión de WhatsApp Web o Desktop tomó el control de este número.',
      disconnected: 'La conexión se cayó y no se ha recuperado.',
    },
    fix: {
      logged_out: 'Abre WhatsApp en el menú lateral de la subcuenta, busca el número, haz clic en Vincular de nuevo y escanea el código QR.',
      banned: 'Abre WhatsApp en el teléfono para ver el aviso. Puede que tengas que solicitar una revisión antes de volver a vincularlo.',
      replaced: 'Cierra las demás sesiones de WhatsApp Web o Desktop de este número y haz clic en Reconectar.',
      disconnected: 'Seguimos reintentando automáticamente. Comprueba que el teléfono esté encendido y con internet. Si sigue caído, haz clic en Reconectar.',
    },
    impact: 'Los mensajes de este número no llegarán al CRM hasta que se vuelva a conectar.',
    backBody: 'Los mensajes vuelven a sincronizarse con el CRM.',
    testBody: 'Esto es una prueba. Recibirás una alerta así cuando un número se desconecte.',
    labels: { account: 'Subcuenta', number: 'Número', since: 'Desde', fix: 'Qué hacer' },
    footer: 'Recibes esto porque estás en la lista de alertas de WhatsApp de esta subcuenta.',
  },
  pt: {
    name: 'Português',
    subject: {
      down: '⚠️ {number} está desconectado · {account}',
      reminder: 'Ainda desconectado: {number} · {account}',
      back: '✅ {number} voltou a ficar online · {account}',
      test: 'Alerta de teste · {account}',
    },
    title: { down: 'Um número de WhatsApp foi desconectado', reminder: 'Um número de WhatsApp continua desconectado', back: 'Seu número de WhatsApp voltou a ficar online', test: 'Os alertas estão funcionando' },
    reason: {
      logged_out: 'Ele foi desvinculado no celular (Dispositivos conectados → Sair).',
      banned: 'O WhatsApp restringiu este número.',
      replaced: 'Outra sessão do WhatsApp Web ou Desktop assumiu este número.',
      disconnected: 'A conexão caiu e não voltou.',
    },
    fix: {
      logged_out: 'Abra o WhatsApp no menu lateral da subconta, encontre o número, clique em Conectar novamente e leia o QR code.',
      banned: 'Abra o WhatsApp no celular para ver o aviso. Talvez seja preciso pedir uma revisão antes de conectá-lo de novo.',
      replaced: 'Feche as outras sessões do WhatsApp Web ou Desktop deste número e clique em Reconectar.',
      disconnected: 'Continuamos tentando automaticamente. Verifique se o celular está ligado e com internet. Se continuar fora, clique em Reconectar.',
    },
    impact: 'As mensagens deste número não chegarão ao CRM até ele ser reconectado.',
    backBody: 'As mensagens voltaram a sincronizar com o CRM.',
    testBody: 'Isto é um teste. Você receberá um alerta assim quando um número se desconectar.',
    labels: { account: 'Subconta', number: 'Número', since: 'Desde', fix: 'O que fazer' },
    footer: 'Você recebe isto porque está na lista de alertas de WhatsApp desta subconta.',
  },
  fr: {
    name: 'Français',
    subject: {
      down: '⚠️ {number} est déconnecté · {account}',
      reminder: 'Toujours déconnecté : {number} · {account}',
      back: '✅ {number} est de nouveau en ligne · {account}',
      test: 'Alerte de test · {account}',
    },
    title: { down: 'Un numéro WhatsApp s’est déconnecté', reminder: 'Un numéro WhatsApp est toujours déconnecté', back: 'Votre numéro WhatsApp est de nouveau en ligne', test: 'Les alertes fonctionnent' },
    reason: {
      logged_out: 'Il a été dissocié depuis le téléphone (Appareils connectés → Se déconnecter).',
      banned: 'WhatsApp a restreint ce numéro.',
      replaced: 'Une autre session WhatsApp Web ou Desktop a pris le contrôle de ce numéro.',
      disconnected: 'La connexion a été perdue et n’est pas revenue.',
    },
    fix: {
      logged_out: 'Ouvrez WhatsApp dans le menu latéral du sous-compte, trouvez le numéro, cliquez sur Relier à nouveau puis scannez le QR code.',
      banned: 'Ouvrez WhatsApp sur le téléphone pour voir l’avis. Vous devrez peut-être demander un examen avant de le relier à nouveau.',
      replaced: 'Fermez les autres sessions WhatsApp Web ou Desktop de ce numéro, puis cliquez sur Reconnecter.',
      disconnected: 'Nous réessayons automatiquement. Vérifiez que le téléphone est allumé et connecté à internet. Si le problème persiste, cliquez sur Reconnecter.',
    },
    impact: 'Les messages de ce numéro n’arriveront pas dans le CRM tant qu’il n’est pas reconnecté.',
    backBody: 'Les messages sont de nouveau synchronisés avec le CRM.',
    testBody: 'Ceci est un test. Vous recevrez une alerte comme celle-ci lorsqu’un numéro se déconnecte.',
    labels: { account: 'Sous-compte', number: 'Numéro', since: 'Depuis', fix: 'Que faire' },
    footer: 'Vous recevez ce message car vous êtes inscrit aux alertes WhatsApp de ce sous-compte.',
  },
  de: {
    name: 'Deutsch',
    subject: {
      down: '⚠️ {number} ist getrennt · {account}',
      reminder: 'Weiterhin getrennt: {number} · {account}',
      back: '✅ {number} ist wieder online · {account}',
      test: 'Testbenachrichtigung · {account}',
    },
    title: { down: 'Eine WhatsApp-Nummer wurde getrennt', reminder: 'Eine WhatsApp-Nummer ist weiterhin getrennt', back: 'Ihre WhatsApp-Nummer ist wieder online', test: 'Benachrichtigungen funktionieren' },
    reason: {
      logged_out: 'Sie wurde am Telefon abgemeldet (Verknüpfte Geräte → Abmelden).',
      banned: 'WhatsApp hat diese Nummer eingeschränkt.',
      replaced: 'Eine andere WhatsApp-Web- oder Desktop-Sitzung hat diese Nummer übernommen.',
      disconnected: 'Die Verbindung ist abgebrochen und nicht zurückgekehrt.',
    },
    fix: {
      logged_out: 'Öffnen Sie WhatsApp im Seitenmenü des Unterkontos, suchen Sie die Nummer, klicken Sie auf Erneut verknüpfen und scannen Sie den QR-Code.',
      banned: 'Öffnen Sie WhatsApp auf dem Telefon, um den Hinweis zu sehen. Eventuell müssen Sie eine Überprüfung beantragen, bevor Sie die Nummer erneut verknüpfen.',
      replaced: 'Schließen Sie andere WhatsApp-Web- oder Desktop-Sitzungen dieser Nummer und klicken Sie dann auf Neu verbinden.',
      disconnected: 'Wir versuchen es automatisch weiter. Prüfen Sie, ob das Telefon eingeschaltet ist und Internet hat. Bleibt sie getrennt, klicken Sie auf Neu verbinden.',
    },
    impact: 'Nachrichten dieser Nummer erreichen das CRM erst wieder, wenn sie neu verbunden ist.',
    backBody: 'Nachrichten werden wieder mit dem CRM synchronisiert.',
    testBody: 'Dies ist ein Test. Sie erhalten eine solche Benachrichtigung, wenn eine Nummer getrennt wird.',
    labels: { account: 'Unterkonto', number: 'Nummer', since: 'Seit', fix: 'Was tun' },
    footer: 'Sie erhalten dies, weil Sie für WhatsApp-Benachrichtigungen dieses Unterkontos eingetragen sind.',
  },
};

const LANGUAGES = Object.entries(STRINGS).map(([code, s]) => ({ code, name: s.name }));

function t(lang) {
  return STRINGS[lang] || STRINGS.en;
}

function fill(str, vars) {
  return String(str).replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? ''));
}

module.exports = { t, fill, LANGUAGES, CODES: Object.keys(STRINGS) };
