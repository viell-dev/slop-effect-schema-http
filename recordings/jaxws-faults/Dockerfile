# The JAX-WS reference implementation bundled with JDK 8 (Eclipse Temurin), publishing two Provider
# endpoints on the JDK's own HTTP server with Endpoint.publish.
FROM eclipse-temurin:8-jdk@sha256:e9255b50040337b0dec91027868dca1952ef5441bf0c8f878c5f790eaedbfea2
COPY Store.java Soap11.java Soap12.java /srv/
RUN mkdir /srv/classes && javac -d /srv/classes /srv/Store.java /srv/Soap11.java /srv/Soap12.java
EXPOSE 8080
CMD ["java", "-cp", "/srv/classes", "Store"]
