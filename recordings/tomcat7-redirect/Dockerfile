# Tomcat 7.0.109, the last Tomcat 7 release, on OpenJDK 8. The same servlet runs twice: as the root
# context with Tomcat's defaults, and as /legacy with useRelativeRedirects="false".
FROM tomcat:7.0.109-jdk8-openjdk@sha256:f7d37d248d0eacec1e5995736234c9c22155626fcb27ea3ead13b9db24e698f7
COPY Customers.java web.xml context-legacy.xml /tmp/app/
RUN rm -rf /usr/local/tomcat/webapps/* \
 && for context in ROOT legacy; do \
      mkdir -p /usr/local/tomcat/webapps/$context/WEB-INF/classes \
   && javac -d /usr/local/tomcat/webapps/$context/WEB-INF/classes \
        -cp /usr/local/tomcat/lib/servlet-api.jar /tmp/app/Customers.java \
   && cp /tmp/app/web.xml /usr/local/tomcat/webapps/$context/WEB-INF/web.xml; \
    done \
 && mkdir -p /usr/local/tomcat/webapps/legacy/META-INF \
 && cp /tmp/app/context-legacy.xml /usr/local/tomcat/webapps/legacy/META-INF/context.xml
EXPOSE 8080
