# The same pinned httpd successor used by the redirect recordings, with real mod_dav/mod_dav_fs.
FROM httpd:2.4.69@sha256:d3accb516506c05ae0068bb54ba6798a10b249b64db91268fca692326cb02b4b
COPY httpd.conf /usr/local/apache2/conf/httpd.conf
COPY documents/ /usr/local/apache2/htdocs/dav/documents/
RUN mkdir -p /usr/local/apache2/var /usr/local/apache2/htdocs/dav/documents/archive \
      /usr/local/apache2/htdocs/dav/documents/templates \
 && touch -d '2024-01-31T12:00:00Z' /usr/local/apache2/htdocs/dav/documents \
      /usr/local/apache2/htdocs/dav/documents/* \
 && chown -R daemon:daemon /usr/local/apache2/var /usr/local/apache2/htdocs/dav
EXPOSE 80
