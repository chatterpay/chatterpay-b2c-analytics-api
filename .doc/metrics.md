# Métricas de ChatterPay Analytics

Definición y cálculo de cada dato de las pantallas Resumen, Usuarios e Ingresos.

- [Reglas comunes](#reglas-comunes)
- [Resumen](#resumen)
- [Usuarios](#usuarios)
- [Ingresos](#ingresos)
- [Diferencias con un conteo on-chain](#diferencias-con-un-conteo-on-chain)

## Reglas comunes

Cada pantalla usa estas reglas.

### Origen de los datos

Cada actualización de datos toma de la base B2C las transacciones, los usuarios, los tokens y las redes, lee los saldos on-chain de las wallets y lee los fills de Polymarket en Polygon. Las cifras reflejan la última actualización.

| Tipo de fila B2C (`transactions`) | Qué es | Dónde cuenta |
|---|---|---|
| `transfer` | Envío desde una wallet de ChatterPay a otro usuario o a una wallet externa. Una transferencia entre dos usuarios de ChatterPay es una sola fila | Volumen, transacciones, comisiones, usuarios activos |
| `swap` | Dos filas por swap: la wallet envía al router y el router le devuelve a la wallet | Volumen, transacciones, comisiones, usuarios activos |
| `deposit` | Ingreso desde una wallet fuera de ChatterPay. El backend no la registra cuando el hash ya existe, así que una transferencia entre usuarios no genera un depósito | En ninguna |
| `polymarket_bridge`, `polymarket_claim`, `polymarket_withdraw` | Movimientos de fondos hacia la cuenta de Polymarket o desde ella | En ninguna |

### Operación contada

Es una transferencia con `status: completed` o un swap completo. Un swap está completo cuando sus dos filas (mismo hash, mismo par de direcciones, sentidos opuestos) están completadas. Un swap con una sola fila, con una fila pendiente o con filas de más no cuenta en ninguna cifra. Las filas de una red fuera del catálogo tampoco cuentan.

### Usuario activo

Es un usuario que inició al menos una operación contada en la ventana. La actividad es de la wallet que envía; en un swap, la del lado de entrada. Una persona cuenta una vez, aunque opere en varias redes.

Estas acciones no vuelven activo a un usuario:

- recibir una transferencia;
- recibir un depósito;
- operar en Polymarket;
- darse de alta sin operar.

### Valuación en USD

- Las stablecoins valen 1 USD.
- El resto toma el precio diario de CoinGecko. Sólo están mapeados ETH, WETH, BTC, WBTC, ADA, POL y MATIC.
- Un swap entre una stablecoin y otro token fija el precio de ese token para ese día. El precio de CoinGecko del mismo día tiene prioridad.
- Volumen y comisiones: un día sin precio toma el día anterior más cercano con precio y, si no hay, el posterior más cercano.
- Saldos: sólo cuenta el precio del mismo día del snapshot.
- Una operación o un saldo sin precio queda fuera de la cifra en USD, nunca se toma como cero. La cifra pasa a ser un subtotal y no se compara con el período anterior. Ejemplo: SCR (Scroll) no tiene precio.
- Los activos de redes de prueba no tienen valor de mercado.

### Períodos

El selector de período de Resumen e Ingresos:

| Período | Ventana | Comparado con |
|---|---|---|
| Hoy | Desde las 00:00 UTC hasta la hora actual | Las mismas horas de ayer |
| 7 días / 30 días / 365 días | Los últimos N días, hoy incluido | Los N días anteriores |
| Año en curso | Desde el 1 de enero hasta la hora actual | Las mismas fechas del año anterior |
| Histórico | Desde el inicio de los datos | Sin comparación |

La variación es (actual − anterior) / anterior × 100. Sin valor anterior, o con valor anterior 0, no hay variación.

### Filtros

- **Red:** el selector de red limita todas las cifras a las redes elegidas.
- **Ocultos:** las redes y los tokens ocultos en Configuración quedan fuera de todas las cifras, comparaciones incluidas.

## Resumen

### Valor total bloqueado

- **Qué muestra:** valor en USD de los saldos de las wallets de usuarios en las redes seleccionadas.
- **Cálculo:** se suman los saldos del último snapshot y se valúan con el precio del día del snapshot.
- **Saldos leídos:**
  - EVM: los tokens ERC-20 de la lista B2C y la moneda nativa cuando la lista la incluye o una master wallet de la red declara su moneda nativa.
  - Cardano: ADA y los activos nativos listados.
- **Ventana:** la cifra es el último snapshot. El período seleccionado no la cambia y la comparación es con el último snapshot del período anterior.
- **Valor bloqueado en el tiempo:** el gráfico toma el último snapshot de cada intervalo del período.
- **Valor bloqueado por red:** el mismo snapshot por red, con su participación.
- **Límites:**
  - Las master wallets no se cuentan.
  - Una wallet cuenta sólo si se leyeron todos sus saldos.
  - Una red que no se pudo leer no cuenta como cero: la cifra pasa a ser el subtotal de las redes leídas.
  - No hay datos anteriores al primer snapshot.

### Volumen total

- **Qué muestra:** valor en USD de las transferencias y los swaps completados del período.
- **Cálculo:** transferencias enviadas + swaps, cada swap al valor del token del que parte.
- **Cómo cuenta cada operación:**
  - Una transferencia cuenta una vez, del lado que la envía, vaya a otro usuario de ChatterPay o a una wallet externa.
  - Un swap cuenta una vez, no una por cada token.
- **Ventana:** el período seleccionado, comparado con el anterior. La línea del indicador es el volumen por intervalo.
- **No incluye:**
  - depósitos desde wallets externas;
  - fills de Polymarket (es otra cifra, en Ingresos);
  - fondeo y retiro de Polymarket;
  - operaciones sin precio en USD.

### Transacciones

- **Qué muestra:** cantidad de operaciones contadas del período.
- **Cálculo:** transferencias completadas + swaps completos. Un swap cuenta una vez aunque tenga dos filas.
- **Ventana:** el período seleccionado, comparado con el anterior.
- **No incluye:** operaciones no completadas, depósitos externos ni operaciones de Polymarket.

### Comisiones totales

- **Qué muestra:** comisiones en USD registradas en las operaciones contadas del período.
- **Cálculo:** campo `fee` de cada transferencia y del lado de entrada de cada swap, valuado en USD.
- **Ventana:** el período seleccionado, comparado con el anterior.
- **Límites:** es la comisión registrada, no un cobro conciliado. Las comisiones sin precio en USD quedan afuera.

### Usuarios activos

- **Qué muestra:** usuarios distintos que iniciaron una operación contada en el período (ver [Usuario activo](#usuario-activo)).
- **Ventana:** el período seleccionado, comparado con el anterior.

### De dónde viene el volumen

- **Qué muestra:** el volumen del período por producto (Transferencias, Swaps, Polymarket), con su participación.
- **Cálculo:**
  - Transferencias y Swaps son las dos partes de Volumen total.
  - Polymarket es el volumen de sus fills (ver [Volumen de Polymarket](#volumen-de-polymarket)).
  - Participación = volumen del producto / suma de los tres productos.
- **Límites:** Polymarket aparece sólo con Todas las redes y no suma en Volumen total.

### Países principales

- **Qué muestra:** los 5 países con más usuarios que tienen wallet en las redes seleccionadas, con su participación.
- **Cálculo:**
  - El país sale del código telefónico del número del usuario.
  - Un código que comparten varios países cuenta como Desconocido.
  - El número se lee durante la actualización y no se guarda.
- **Ventana:** la última actualización de datos. El período seleccionado no aplica.

### Saldos por token

- **Qué muestra:** unidades y valor en USD de cada token en las wallets de usuarios, con su participación.
- **Cálculo:** el mismo snapshot que Valor total bloqueado.
- **Ventana:** el último snapshot. El período seleccionado no aplica.
- **Límites:** un token sin precio muestra sus unidades y "Sin valor en USD", y queda fuera de los porcentajes.

### Tokens más usados

- **Qué muestra:** los 8 tokens con más operaciones del período, por token y red, con su volumen en USD y su cantidad de operaciones.
- **Cálculo:**
  - Una transferencia cuenta en el token enviado.
  - Un swap cuenta en el token del que parte, con todo su volumen y su comisión.
- **Ventana:** el período seleccionado.
- **Límites:**
  - El volumen está en USD sólo si todas las operaciones del token tienen precio.
  - El mismo símbolo en dos redes son dos filas.
  - Son flujos del período, no saldos.

## Usuarios

El selector Diario / Mensual / Anual define la cifra principal, el gráfico y el desglose por red.

| Selección | Cifra principal | Gráfico | Ventana del desglose por red |
|---|---|---|---|
| Diario | Usuarios activos diarios | Usuarios activos por día, últimos 30 días | Hoy |
| Mensual | Usuarios activos mensuales | Usuarios activos por mes calendario, últimos 12 meses | Últimos 30 días |
| Anual | Usuarios activos anuales | Usuarios activos por año, desde el inicio de los datos | Últimos 365 días |

### Usuarios activos diarios, mensuales y anuales

- **Qué muestra:** usuarios distintos que iniciaron una operación contada en la ventana (ver [Usuario activo](#usuario-activo)). La ventana elegida va como cifra principal y las otras dos como indicadores.
- **Ventanas:**

  | Dato | Ventana | Comparado con |
  |---|---|---|
  | Usuarios activos diarios (DAU) | Hoy desde las 00:00 UTC hasta la hora actual | Las mismas horas de ayer |
  | Usuarios activos mensuales (MAU) | Los 30 días hasta la hora actual | Los 30 días anteriores |
  | Usuarios activos anuales | Los 365 días hasta la hora actual | Los 365 días anteriores |

- **Gráfico:** en Mensual, el gráfico va por mes calendario y el MAU por los últimos 30 días móviles, así que el último punto del gráfico y el MAU pueden diferir.

### Total de usuarios

- **Qué muestra:** personas con cuenta en ChatterPay y wallet en las redes seleccionadas, cada una contada una vez.
- **Incluye:** usuarios que nunca operaron y usuarios sin fecha de alta.
- **Ventana:** todas las altas hasta ahora. No es una cifra de usuarios activos.

### Wallets nuevas (30 días)

- **Qué muestra:** wallets (red + dirección de un usuario) que aparecieron por primera vez en los últimos 30 días, comparadas con los 30 anteriores.
- **Cálculo:** una wallet cuenta una vez, en su primera aparición verificable. Es la anterior de estas dos fechas:
  - su primera operación completada, como origen o destino;
  - la primera actualización de datos que la vio cuando la anterior no la había visto.
- **Límites:**
  - Una wallet sin ninguna de las dos fechas no se cuenta.
  - La fecha de alta del usuario no se usa como fecha de la wallet.
  - Con wallets sin verificar, la cifra es un mínimo y no tiene comparación.

### Recurrencia (DAU/MAU)

- **Qué muestra:** proporción de los usuarios activos del mes que también estuvieron activos hoy.
- **Cálculo:** 100 × DAU / MAU.
- **Comparación:** variación en puntos porcentuales respecto del mismo cociente de las ventanas anteriores.
- **Límites:** sin MAU no hay cociente y el indicador muestra —.

### Cuántos vuelven

- **Qué muestra:** porcentaje de usuarios activos otra vez 1, 3 y 6 meses después del mes de alta.
- **Cálculo:**
  - Cohortes mensuales por mes de alta, en UTC. "Activo" sigue la definición de [Usuario activo](#usuario-activo).
  - Para cada mes N se promedian las últimas 12 cohortes que ya tienen N meses completos después del suyo, ponderadas por tamaño.
- **Límites:** los usuarios sin fecha de alta no pertenecen a ninguna cohorte.
- **Ver tabla de cohortes (Retención por cohorte mensual):** las últimas 6 cohortes completas. Cada fila muestra el mes de alta, la cantidad de usuarios y el porcentaje activo en cada mes posterior.

### Wallets nuevas por red

- **Qué muestra:** wallets nuevas de cada red en la ventana de la selección, con su participación.
- **Cálculo:** la misma definición que Wallets nuevas (30 días). Debajo de cada red: wallets verificadas / wallets totales de la red.

### Usuarios por red

Está en Detalles.

- **Qué muestra:** usuarios activos de cada red en la ventana del desglose, con su participación y su total de usuarios.
- **Límites:** cada red cuenta sus propios usuarios, así que una persona activa en dos redes aparece en las dos filas y las filas pueden sumar más que el total.

## Ingresos

### Comisiones totales

- **Qué muestra:** comisiones en USD registradas en las operaciones contadas del período, como en Resumen.
- **Cálculo:** campo `fee` de cada transferencia y del lado de entrada de cada swap, valuado en USD.
- **Comisiones en el tiempo:** las barras muestran las comisiones de cada intervalo. Un intervalo cuyas operaciones no tienen precio no muestra barra.
- **Límites:** es la comisión registrada, no un cobro conciliado.

### Volumen total

Es la misma cifra que en Resumen (ver [Volumen total](#volumen-total)).

### Volumen de swaps

- **Qué muestra:** la parte de Volumen total que corresponde a swaps.
- **Cálculo:** valor en USD del token del que parte cada swap. El token que recibe no suma.
- **Swap sin precio:** si el token de entrada no tiene precio y el de salida es una stablecoin, se usa el monto de la stablecoin.
- **Ventana:** el período seleccionado, comparado con el anterior.

### Volumen de Polymarket

El indicador muestra Volumen de Polymarket cuando hay fills leídos. Si no hay, muestra Cuentas de Polymarket.

- **Volumen de Polymarket:**
  - **Cálculo:** pUSD pagados en fills de compra + pUSD recibidos en fills de venta, a 1 pUSD = 1 USD. Cada fill cuenta una vez.
  - **Fuente:** los eventos `OrderFilled` de los exchanges CLOB V2 de Polymarket en Polygon cuyo maker es la cuenta de Polymarket del usuario.
  - **Filas B2C:** no se usan, porque el backend marca una orden como completada cuando el order book la acepta y guarda el monto pedido, no el ejecutado.
  - **Sin fills en el período:** se muestra la fecha del último fill.
  - **Lectura incompleta:** si la lectura no llegó al final del período, se muestra hasta qué hora se leyó.
- **Cuentas de Polymarket:** usuarios con cuenta de Polymarket vinculada y dirección de Polygon válida. Cada usuario cuenta una vez.
- **Límites:**
  - El filtro de red no aplica.
  - No suma en Volumen total.
  - ChatterPay no cobra comisión sobre estas órdenes.

### Comisión promedio por transacción

- **Qué muestra:** comisión promedio registrada por operación contada.
- **Cálculo:** Comisiones totales / Transacciones, con hasta 4 decimales.
- **Ventana:** el período seleccionado, comparado con el anterior.
- **Límites:** sin operaciones no hay cifra.

### Comisiones por producto

- **Qué muestra:** comisiones del período de Transferencias, Swaps y Polymarket, con su participación.
- **Participación:** comisiones del producto / comisiones totales.
- **Tasa promedio (junto al título):** comisiones totales / volumen total. Sólo aparece cuando las dos cifras tienen todas sus operaciones valuadas.
- **Polymarket:** muestra US$ 0,00, sólo con Todas las redes, porque ChatterPay envía las órdenes sin builder code. La comisión que cobra Polymarket en un fill la paga el usuario a Polymarket y no está incluida.

### Comisiones por red

- **Qué muestra:** comisiones del período por red. Debajo de cada red: comisiones de transferencias, comisiones de swaps y volumen.
- **Cálculo:**
  - Comisiones de la red = comisiones de transferencias + comisiones de swaps.
  - Participación = comisiones de la red / comisiones totales.
- **Ver comisiones por activo (Por activo):** tabla con volumen, comisiones y participación por token y red.
- **Límites:** una red cuyas operaciones no tienen precio no muestra cifra.

### Master wallets

- **Qué muestra:** saldos de las direcciones de los firmantes de ChatterPay. Cada fila muestra la red, el rol, la dirección con link al explorador, el valor en USD, la participación y los saldos en unidades.
- **Cálculo:**
  - Toma el último snapshot y valúa con el precio del día.
  - El total junto al título suma los saldos con precio.
- **Saldos sin precio:** un saldo sin precio se lista en unidades con "Sin valor en USD" y queda fuera del total. El total pasa a llamarse Subtotal valuado y las participaciones son sobre ese subtotal.
- **Límites:**
  - No son comisiones ni ingresos.
  - No suman en Valor total bloqueado.
  - El período seleccionado no aplica.

## Diferencias con un conteo on-chain

Un conteo que suma los eventos de transferencia on-chain de las wallets da un volumen mayor que Volumen total:

| Caso | Conteo on-chain típico | ChatterPay Analytics |
|---|---|---|
| Transferencia entre dos usuarios de ChatterPay | Salida de una wallet + entrada en la otra: 2 veces | 1 vez |
| Swap | Token que sale + token que entra: 2 veces | 1 vez, por el token de entrada |
| Depósito desde una wallet externa | Se cuenta | No se cuenta |
| Fondeo y retiro de Polymarket | Se cuentan como transferencias | No se cuentan |
| Fills de Polymarket | Según la consulta | Cifra aparte, fuera de Volumen total |
| Tokens sin precio (por ejemplo SCR) | Según la tabla de precios de la plataforma | Fuera de la cifra en USD |
| Operaciones fallidas o swaps incompletos | Según la consulta | No se cuentan |
