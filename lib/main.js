/*
    QuickWikiEditor -  A Firefox-addon to edit mediawikibased sites
    Copyright (C) 2013 Michael F. Schönitzer

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/

var Request = require("sdk/request").Request;
var selection = require("sdk/selection");
var { Hotkey } = require("sdk/hotkeys");
var tabs = require("sdk/tabs");
var simpleprefs = require("sdk/simple-prefs");

// List of supported Wikis
var supportedwikis = new Array("wikipedia.org", "wikibooks.org", "wikinews.org", "wikionary.org", "wikiquote.org", "wikisource.org", "wikivoyage.org", "wikiversity.org");

// Listen, if the edit-Hotkey is pressed
var showHotKey = Hotkey({
  combo: simpleprefs.prefs.hotkey,
  onPress: function() {
    // get selected text
    var from = selection.html;

    if ( from == null)
      return -1;
    
    // Convert HTML-formatting into Wikicode (if supported)
    from = html2wikicode(from);
    // Check if it conversion succeeded (aka now unsupported formatting was included)
    if ( from == -1 )
      return -1;
    
    article = getarticlename(tabs.activeTab.url)
    if (article == -1)
      return -1;
      
    // now ask for how to edit, this has to be done in an contentscript
    asker = tabs.activeTab.attach({
      contentScript: "self.port.emit('message', window.prompt('Edit to what?', '" + from.replace(/'/g, "\\'") + "'));"
      });
    asker.port.on('message', function(addonMessage) {
      
      if (addonMessage == null)
        return -1;
      var to = addonMessage;
      // Sow the edited page:
      selection.html = wikicode2html(to);
      
      //Start process of saving the change
      // Step I: get the source code
      var success = getsourcecode(article, from, to);
      //console.log(success);
      // If something went wrong undo the change of the page
      //if ( success == -1 ) // XXX: Does not work
      //   selection.html = from;
      });
  }
});


// show an errormassage
function showerror(errormsg) {
    tabs.activeTab.attach({
      contentScript: "window.alert('" + errormsg + "');"
      });
}


// Check if string contains any HTML-code
function check4html(string) {
    if ( string.indexOf("<") != -1 ) {
      showerror("Selection includes unsupported tags.");
      return -1;
    }
    else
      return 0;
}

// Convert HTML-Elements into Wikicode
// Supported for now: bold, wikilinks and encoded &<>
function html2wikicode(html) {
    // Replace blue wikilinks with [[foo|bar]]
    var tmp = html.replace(/<a href=\"\/wiki\/(.*)\" title=\".*\">/, '[[$1|').replace("</a>","]]");
    // Replace red wikilinks witch [[foo|bar]]
    tmp = tmp.replace(/<a href=\"\/w\/index.php\?title=(.*)&amp;action=edit&amp;redlink=1\" class=\"new\" title=\".*\">/, '[[$1|').replace("</a>","]]");
    // [[foo|foo]] -> [[foo]]
    tmp = tmp.replace(/\[\[(\w+)\|\1\]\]/, '$1');
    // remove <b></b> (nonsense sometimes added by Firefox)
    tmp = tmp.replace(/<b>\s*<\/b>/, '');
    // Replace bold text with '''text'''
    tmp = tmp.replace("<b>", "'''").replace("</b>","'''");
    // Replace italic text with ''text''
    tmp = tmp.replace("<i>", "''").replace("</i>","''");
    // Remove span-tag of headings
    tmp = tmp.replace(/<span class="mw-headline" id="[^"]*">/, '').replace("</span>", '');
    //console.log(tmp);
    // Check if all HTML was replaced, if not display errormsg and exit
    if ( check4html(tmp) == -1 )
      return -1;
    // decode HTML-characters
    tmp = tmp.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
    return tmp;
}


// Convert Wikicode into HTML
// Supported for now: bold, (blue) wikilinks and encoded &<>
function wikicode2html(wiki) {
    // encode HTML-characters
    var tmp = wiki;
    tmp = tmp.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    // [[foo]] -> [[foo|foo]]
    tmp = tmp.replace(/\[\[([^\[\]\|]*)\]\]/, '[[$1|$1]]');
    // Create Wikilink from [[foo|bar]]
    tmp = tmp.replace(/\[\[([^|\[\]]*)\|([^|\[\]]*)\]\]/, '<a href="/wiki/$1">$2</a>');
    // Create bold text from '''text'''
    tmp = tmp.replace(/\'\'\'(.*)\'\'\'/, '<b>$1</b>');
    // Create italic text from ''text''
    tmp = tmp.replace(/\'\'(.*)\'\'/, '<i>$1</i>');
    return tmp;
}



// Extract articlename out of url
function getarticlename(url) {
    article=new Object();
    for ( i in supportedwikis ) {
      domain = supportedwikis[i];
      var domainpos = url.search(new RegExp("[a-zA-Z]*\." + domain));
      if ( domainpos == -1)
        continue;
      else {
        article.lang=url.replace(new RegExp(".*[./]([a-zA-Z]*)\." + domain + "/.*"), '$1');
        article.site=domain;
        break;
      }
    }
    // Site is none of the above – maybe even not a wiki – stop
    if ( typeof(article.site)=="undefined" ) {
      showerror("Error: Site not (yet) supported.");
      return -1;
    }
    // Can't extract articlename
    if ( url.search("/wiki/") == -1 ) {
      showerror("Error: URL can't be decoded.")
      return -1;
    }
    else 
      article.name=url.substring(url.search("/wiki/")+6);
    return article;
}



// Get the sourcecode of the article
// then call next Step of edit-procedure
function getsourcecode(article, from, to) {
  var sourcecoderequest = Request({
    url: "https://" + article.lang + "." + article.site + "/w/api.php?format=json&action=query&titles=" 
         + article.name + "&prop=revisions&rvprop=content",
    onComplete: function (response) {
      if ( response.status != 200 ) {
         showerror("An error occurred getting the sourcecode. Statuscode: " + response.status );
         return -1;
      }
      if ( typeof response.headers["MediaWiki-API-Error"] != "undefined" )  {
         showerror("An error occurred getting the sourcecode. API-Error: " + response.headers["MediaWiki-API-Error"] );
         return -1;
      }
      
      pages = response.json.query.pages;
      // The JSON includes a object named like the number of the article, witch we don't know
      // so use a loop to access it without needing the articlenumber
      for each ( var page in pages) {
         sourcecode = page.revisions[0]['*'];
      }
      if ( typeof sourcecode == "undefined" ) {
          showerror("An unknown error occurred while getting the sourcecode.");
          return -1;
      }
      // Edit the text
      sourcecode = edittext(sourcecode, from, to);
      if ( sourcecode == -1 )
        return -1;
      
      // Generate summary
      var summary;
      if ( simpleprefs.prefs.summary == "_AUTO_" )
        summary = from + " -> " + to;
      else
        summary = simpleprefs.prefs.summary;
      // Step II: get edit-token
      gettoken(article, sourcecode, summary);
    }
  }).get();
}



//Apply edits to the sourcecode 
function edittext(sourcecode, from, to) {
  //Check if 'from' can be found in sourcecode
  if ( sourcecode.indexOf(from) == -1 ) {
    // If not it can be, because of Firefox added additional
    // HTML-Code at the beginning or at the end of the selectiontext
    // Remove this (if existing) and try one more.
    newfrom = from.replace(/^'''/, '').replace(/'''$/, '');
    newfrom = newfrom.replace(/^\[\[.*\|/, '').replace(/\]\]$/, '');
    newto = to.replace(/^'''/, '').replace(/'''$/, '');
    newto = to.replace(/^''/, '').replace(/''$/, '');
    newto = newto.replace(/^\[\[.*\|/, '').replace(/\]\]$/, '');
    if ( newfrom == from ) {
      showerror("Error: Searching text in sourcecode failed.")
      return -1;
    }
    else {
        return edittext(sourcecode, newfrom, newto);
    }
  }
  // Edit the sourcecode
  var editedsource = sourcecode.replace(from, to);
  // Check if text appears multiple times in source
  // if so we can't determine witch one was meant.
  if ( sourcecode.indexOf(from, sourcecode.indexOf(from)+1) != -1 ) {
      showerror("The selected text appears multiple times in the source, please use a bigger selection.");
      return -1;
  }
  else
     return editedsource;
}



// Get the Edit token
// then call next Step of edit-procedure
function gettoken(article, sourcecode, summary) {
  var tokenrequest = Request({
    url: "https://" + article.lang + "." + article.site + "/w/api.php?action=tokens&type=edit&format=json",
    onComplete: function (response) {
      if ( response.status != 200 ) {
         showerror("An error occurred getting the edittoken. Statuscode: " + response.status );
         return -1;
      }
      if ( typeof response.headers["MediaWiki-API-Error"] != "undefined" )  {
         showerror("An error occurred getting the edittoken. API-Error: " + response.headers["MediaWiki-API-Error"] );
         return -1;
      }
      
      // Extract token from JSON
      var token = response.json;
      token = token.tokens.edittoken;
      if ( typeof token == "undefined" ) {
          showerror("An unknown error occurred getting the edittoken.");
          return -1;
      }
      // Step III: save the article
      savepage(article, sourcecode, token, summary);
    }
  }).get();
}



// Save the article
function savepage(article, sourcecode, token, summary) {
  var minor="";
  if ( simpleprefs.prefs.minor )
    minor="&minor";
  var editrequest = Request({
    url: "https://" + article.lang + "." + article.site + "/w/api.php?action=edit&format=json&title="
      + article.name
      + "&summary=" + encodeURIComponent(summary)
      + minor
      + "&token=" + encodeURIComponent(token),
    content: "text=" + encodeURIComponent(sourcecode),
    onComplete: checksuccess
  }).post();
}


// Check for errors when saving page
function checksuccess(response) {
      if ( response.status != 200 )
         showerror("An error occurred saving the page. Statuscode: " + response.status );
      if ( typeof response.headers["MediaWiki-API-Error"] != "undefined" ) 
         showerror("An error occurred saving the page. API-Error: " + response.headers["MediaWiki-API-Error"] );
      else
         console.log("saved!");
    }

