const hasSas = (searchStr: string) => {
  const params = new URLSearchParams(searchStr);
  return params.has('sv') && params.has('ss') && params.has('srt') && params.has('spr') && params.has('st') && params.has('se') && params.has('sp') && params.has('sig');
};
const getSas = (searchStr: string) => {
  const params = new URLSearchParams(searchStr);
  return '?sv=' + params.get('sv') + '&ss=' + params.get('ss') + '&srt=' + params.get('srt') + '&spr=' +  params.get('spr') + '&st=' +  params.get('st') + '&se=' +  params.get('se') + '&sp=' +  params.get('sp') + '&sig=' +  encodeURIComponent(params.get('sig'));
};
const sas = getSas(window.location.search);
const replaceHistoryState = ({ hash, href, pathname, search }) => {
  if (hasSas(search)) {
    return;
  }
  
  if (search === '' && hash === '') {
    history.replaceState(null, '', href + sas);
  } else if (search === '' && hash !== '') {
    history.replaceState(null, '', pathname + sas + location.hash);
  } else if (search !== '' && hash === '') {
    history.replaceState(null, '', href + '&' + sas.slice(1));
  } else {
    history.replaceState(null, '', pathname + search + '&' + sas.slice(1) + hash);
  }
};
const observeUrlChange = () => {
  let oldHref = window.location.href;
  const body = document.querySelector("body");
  const observer = new MutationObserver(() => {
    if (oldHref !== window.location.href) {
      oldHref = window.location.href;
      replaceHistoryState(window.location);
    }
  });
  observer.observe(body, { childList: true, subtree: true, attributes: true, characterData: true });
};

let refreshing = false;
navigator.serviceWorker.addEventListener('controllerchange', () => {
  if (refreshing) return;
  refreshing = true;
  window.location.reload();
});

(async () => {
  for (const registration of await navigator.serviceWorker.getRegistrations()) {
    registration.unregister();
  }
  await navigator.serviceWorker.register("./appendSas.js" + sas);
})();

window.addEventListener('load', () => observeUrlChange());
