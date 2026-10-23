# Instruções para o Claude

## Publicação
- O dono do repositório autorizou subir sem perguntar: ao terminar uma alteração, valide (tipagem das Edge Functions com `deno check`; no `index.html`, que o script carrega sem erro), publique a Edge Function alterada no Supabase (projeto `qrvdqqdigzabltqgxggm`, mesmo `verify_jwt` de antes, junto com `_shared/` quando ela importar de lá), faça commit, push, abra o PR para `main` e mescle, sem pedir confirmação.
