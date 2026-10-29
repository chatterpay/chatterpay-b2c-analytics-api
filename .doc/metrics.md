# Métricas de ChatterPay Analytics

Cálculo de cada dato que muestra el sitio. La definición técnica de cada bloque de la API está en el [README](../README.md#metric-blocks); este documento la describe por pantalla.

## Origen de los datos

Una actualización de datos (`POST /v1/internal/ingest`, disparada por Cloud Scheduler) copia de la base B2C las colecciones `transactions`, `users`, `tokens` y `blockchains`, lee los saldos on-chain de las wallets y los fills de Polymarket en Polygon, y reconstruye los agregados. El sitio nunca lee la base B2C ni la blockchain.

Tipos de fila de `transactions` que usa cada métrica:

| Tipo B2C | Qué es | Uso |
|---|---|---|
| `transfer` | Envío desde una wallet de ChatterPay a otro usuario o a una wallet externa. Una transferencia entre dos usuarios de ChatterPay es una sola fila | Volumen, operaciones, comisiones, usuarios activos |
| `swap` | Dos filas por swap: la wallet envía al router y el router devuelve a la wallet | Volumen, operaciones, comisiones, usuarios activos |
| `deposit` | Ingreso desde una wallet fuera de ChatterPay. El backend no la registra cuando el hash ya existe, así que una transferencia entre usuarios no genera un depósito | No se usa |
| `polymarket_bridge`, `polymarket_claim`, `polymarket_withdraw` | Movimientos de fondos hacia o desde la cuenta de Polymarket | No se usan |

Sólo cuentan las filas con `status: completed`. Las filas de una red que no está en el catálogo no cuentan.

## Valuación en USD

- Las stablecoins valen 1 USD.
- El resto toma el precio diario de CoinGecko. Sólo están mapeados ETH, WETH, BTC, WBTC, ADA, POL y MATIC.
- Un swap entre una stablecoin y otro token fija el precio de ese token para ese día; el precio de CoinGecko del mismo día tiene prioridad.
- Volumen y comisiones: un día sin precio toma el día anterior más cercano con precio y, si no hay, el posterior más cercano.
- Saldos (TVL, saldos por token, master wallets): sólo el precio del mismo día del snapshot.
- Una operación o saldo sin precio queda afuera de la cifra en USD, nunca se toma como cero. La cifra pasa a ser un subtotal y no tiene comparación con el período anterior.
- Los activos de redes de prueba no tienen valor de mercado.

Ejemplo: SCR (Scroll) no tiene precio, así que sus transferencias y saldos quedan fuera de los totales en USD y se muestran en unidades del token.

## Períodos y comparación

| Período | Ventana | Comparado con |
|---|---|---|
| Hoy | Desde las 00:00 UTC hasta la hora actual | Las mismas horas de ayer |
| 7 días / 30 días / 365 días | Los últimos N días, hoy incluido | Los N días anteriores |
| Año en curso | Desde el 1 de enero hasta la hora actual | Las mismas fechas del año anterior |
| Histórico | Desde el inicio de los datos | Sin comparación |

Variación = (actual − anterior) / anterior × 100. Sin valor anterior, o con valor anterior 0, no hay variación.

Las redes y los tokens ocultos desde Configuración quedan fuera de todas las cifras, comparaciones incluidas.

## Operaciones

| Dato | Cálculo |
|---|---|
| Operaciones | Transferencias completadas + swaps completos del período. Un swap cuenta una vez aunque tenga dos filas |
| Swap completo | Las dos filas del swap (mismo hash, mismo par de direcciones, sentidos opuestos) completadas. Un swap con una sola fila, con una fila pendiente o con filas de más queda afuera de todos los conteos |
| Volumen | Valor en USD de las transferencias enviadas + valor en USD del lado de entrada de los swaps |
| Volumen de swaps | Valor en USD del token del que parte cada swap. Si ese token no tiene precio y el que recibe es una stablecoin, se usa el monto de la stablecoin |
| Comisiones | Campo `fee` registrado en cada transferencia y en el lado de entrada de cada swap, valuado en USD. Es la comisión registrada, no un cobro conciliado |
| Comisión promedio por operación | Comisiones / operaciones, con hasta 4 decimales |
| Tasa de comisión | Comisiones / volumen. Sólo cuando las dos cifras tienen todas sus operaciones valuadas |

Reglas del volumen:

- Una transferencia cuenta una vez, del lado que la envía, vaya a otro usuario de ChatterPay o a una wallet externa. La recepción no suma otra vez.
- Un swap cuenta una vez, por el valor del token de entrada. El token de salida no suma.
- Los depósitos desde wallets externas no se cuentan.
- Polymarket no suma en Volumen total: sus fills están en Polygon, fuera de las redes de ChatterPay. Se muestra como cifra aparte.

### Volumen por producto

Volumen de transferencias, de swaps y de Polymarket, con su participación. Polymarket aparece sólo con Todas las redes, y las participaciones son sobre los tres productos.

### Tokens más usados

Operaciones y volumen por token y red en el período. Una transferencia cuenta en el token enviado; un swap cuenta en el token del que parte, con todo su volumen y su comisión.

### Comisiones por producto, por red y por activo

- Por producto: comisiones de transferencias, de swaps y de Polymarket. Polymarket muestra 0: ChatterPay envía las órdenes sin builder code y no cobra comisión. La comisión que cobra Polymarket la paga el usuario a Polymarket y no está incluida.
- Por red: comisiones de transferencias + comisiones de swaps de la red, con su volumen. Participación = comisiones de la red / comisiones totales.
- Por activo: volumen y comisiones por token y red.

## Polymarket

| Dato | Cálculo |
|---|---|
| Cuentas de Polymarket | Usuarios con cuenta de Polymarket vinculada y dirección de Polygon válida. Cada usuario cuenta una vez. El filtro de red no aplica |
| Volumen de Polymarket | pUSD pagados en fills de compra + pUSD recibidos en fills de venta, a 1 pUSD = 1 USD. Cada fill cuenta una vez |

Los fills se leen de los eventos `OrderFilled` de los exchanges CLOB V2 de Polymarket en Polygon cuyo maker es la cuenta de Polymarket del usuario. No se usan las filas B2C de órdenes: el backend las marca como completadas cuando el order book las acepta y guarda el monto pedido, no el ejecutado. Sin fills en el período, el sitio muestra la fecha del último fill.

## Usuarios

### Usuarios activos

Usuario activo: inició al menos una transferencia completada o un swap completo en la ventana. La actividad se atribuye a la wallet que envía (en un swap, la del lado de entrada).

No vuelven activo a un usuario:

- recibir una transferencia o un depósito;
- operar en Polymarket;
- darse de alta sin operar.

| Dato | Ventana |
|---|---|
| DAU | Hoy desde las 00:00 UTC hasta la hora actual, comparado con las mismas horas de ayer |
| MAU | Los 30 días hasta la hora actual, comparados con los 30 anteriores |
| YAU | Los 365 días hasta la hora actual, comparados con los 365 anteriores |
| Usuarios activos (Resumen) | El período seleccionado |
| Stickiness | 100 × DAU / MAU |

Una persona cuenta una vez aunque opere en varias redes. En el desglose por red cuenta en cada red donde operó, así que las filas pueden sumar más que el total.

### Altas y totales

| Dato | Cálculo |
|---|---|
| Usuarios totales | Usuarios B2C con wallet en las redes seleccionadas, cada uno una vez, incluidos los que nunca operaron y los que no tienen fecha de alta |
| Usuarios nuevos | Usuarios con fecha de alta (`createdAt`) en los últimos 30 días, comparados con los 30 anteriores |
| Wallets nuevas | Wallets (red + dirección) en su primera aparición verificable: la anterior entre su primera operación completada (como origen o destino) y la primera actualización de datos que la vio cuando la anterior no la había visto. Una wallet sin ninguna de las dos no se cuenta |

### Retención

Cohortes mensuales por mes de alta (UTC). Retención al mes N = usuarios de la cohorte activos (misma definición de usuario activo) en el mes N después del alta. El resumen de 1, 3 y 6 meses promedia las últimas 12 cohortes que ya cumplieron N meses completos, ponderado por tamaño. Los usuarios sin fecha de alta no pertenecen a ninguna cohorte.

### Países

Usuarios con wallet en las redes seleccionadas, por país del código telefónico de su número. Un código compartido por varios países cuenta como Desconocido. El número se lee durante la actualización y no se guarda; el período seleccionado no aplica.

## Saldos

| Dato | Cálculo |
|---|---|
| TVL | Valor en USD de los saldos de las wallets de usuarios, del último snapshot de saldos. Cada serie toma el último snapshot de cada intervalo. No incluye las master wallets |
| Saldos por token | Unidades y valor en USD por token, del mismo snapshot que el TVL |
| Master wallets | Saldos de las direcciones configuradas en `MASTER_WALLETS`, del último snapshot. No son comisiones ni ingresos. Un saldo sin precio se lista en unidades y queda fuera del total, que pasa a ser un subtotal valuado |

Saldos leídos: en EVM, los tokens ERC-20 de la lista B2C y la moneda nativa cuando la lista la incluye o una master wallet de la red declara `nativeSymbol`; en Cardano, ADA y los activos nativos listados. Una wallet cuenta en el snapshot sólo si se leyeron todos sus saldos. Una red que no se pudo leer no cuenta como cero: el dato pasa a ser parcial.

## Diferencias con un conteo on-chain

Un tablero que suma eventos de transferencia on-chain de las wallets (por ejemplo, en Dune) da un volumen mayor por estas reglas:

| Caso | Conteo on-chain típico | ChatterPay Analytics |
|---|---|---|
| Transferencia entre dos usuarios de ChatterPay | Salida de una wallet + entrada en la otra: 2 veces | 1 vez |
| Swap | Token que sale + token que entra: 2 veces | 1 vez, por el token de entrada |
| Depósito desde una wallet externa | Se cuenta | No se cuenta |
| Fondeo y retiro de Polymarket | Se cuentan como transferencias | No se cuentan |
| Fills de Polymarket | Según la consulta | Cifra aparte, fuera de Volumen total |
| Tokens sin precio (por ejemplo SCR) | Según la tabla de precios de la plataforma | Fuera de la cifra en USD |
| Operaciones fallidas o swaps incompletos | Según la consulta | No se cuentan |
