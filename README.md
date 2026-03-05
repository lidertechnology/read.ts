El servicio ahora cubre todo lo que necesitas. Aquí está el resumen de los 8 métodos:
MétodoPara qué sirveobtenerDocumentos()Lista paginada con estado reactivo. 
Scroll infinito / "cargar más"obtenerPorId()
Vista detalle de un documento. Soporta cachéconsultar()One-shot sin tocar el estado. 
Para modales y sub-consultas. Soporta cachéescuchar()Lista en tiempo real. Chat, notificaciones, stock en vivoescucharDocumento()Documento único en tiempo real. 
Estado de pedido, 
configcontarDocumentos()Totales y badges sin descargar 
datosbuscarPorTexto()Búsqueda por prefijo sobre cualquier campo textoconsultarGrupo()Sub-colecciones anidadas con collectionGroup
Tres cosas que no debes olvidar en los componentes:

Siempre providers: [ReadService] en el @Component para estado aislado
Siempre reset() antes de cambiar filtros
Siempre detenerEscucha(key) en ngOnDestroy() si usas tiempo real
