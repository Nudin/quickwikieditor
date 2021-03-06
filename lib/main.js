/*
    QuickWikiEditor -  A Firefox-add-on to edit mediawikibased sites
    Copyright (C) 2013-2014 Michael F. Schönitzer

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
var _ = require("sdk/l10n").get;
var data = require("sdk/self").data;
var ui = require("sdk/ui");
var cm = require("sdk/context-menu");

// List of supported Wikis
var supportedwikis = new Array("*.wikipedia.org", "*.wikibooks.org", "*.wikinews.org", "*.wikionary.org", "*.wikiquote.org", "*.wikisource.org", "*.wikivoyage.org", "*.wikiversity.org", "*.wikimedia.org");

// Add Widget
if ( simpleprefs.prefs.viewicon )
  var statuswidget = ui.ActionButton({
    id: "status-widget",
    label: "QuickWikiEditor",
    tooltip: "QuickWikiEditor "+ _("idle"),
    icon: "./qwe-idle.png",
    onClick: altfunction
  });

// Add Context-Menu
if ( simpleprefs.prefs.viewcontextmenu )
  cm.Item({
    label: "QuickWikiEditor",
    image: data.url("qwe-idle.png"),
    context: [cm.URLContext(supportedwikis), cm.SelectionContext()],
    contentScript: 'self.on("click", function (node, data) {' +
                 '  self.postMessage("message");' +
                 '});',
    onMessage: editarticle
  });

// Listen, if the edit-Hotkey is pressed
var showHotKey = Hotkey({
  combo: simpleprefs.prefs.hotkey,
  onPress: editarticle
});

// Listen, if the link-Hotkey is pressed
var linkHotKey = Hotkey({
  combo: simpleprefs.prefs.linkhotkey,
  onPress: linkword
});

var htmlfrom;

// altfunction: function witch is called when clicking on the Widget
function altfunction() {
    switch (simpleprefs.prefs.altfunction) {
    case 0: 
      openeditpage();
      break;
    case 1: 
      openwatchlist();
      break;
    }
}

// Open watchlist in new tab
function openwatchlist() {
    article = getarticlename(tabs.activeTab.url);
    url = "https://" + article.lang + "." + article.site + "/wiki/Special:Watchlist";
    tabs.open(url);
}

// Open editpage in new tab
function openeditpage() {
    article = getarticlename(tabs.activeTab.url);
    url = "https://" + article.lang + "." + article.site + "/w/index.php?title=" + article.name + "&action=edit";
    tabs.open(url);
}

// Make the current selection to a link (selection -> [[selection]])
function linkword() {
    // get selected text
    var from = selection.html;
    htmlfrom = from;

    if ( from == null)
      return -1;
      
    // Set status-icons
    setstatus("working");
    
    // Convert HTML-formatting into Wikicode (if supported)
    from = html2wikicode(from);
    // Check if it conversion succeeded (aka now unsupported formatting was included)
    if ( from == -1 )
      return -1;
    
    article = getarticlename(tabs.activeTab.url)
    if (article == -1)
      return -1;
    
    var to = "[[" + from + "]]";
    // Sow the edited page:
    selection.html = wikicode2html(to);
    
    //Start process of saving the change
    // Step I: get the source code
    var success = getsourcecode(article, from, to);
}

// Open edit-window for selection
function editarticle() {
    // get selected text
    var from = selection.html;
    htmlfrom = from;

    if ( from == null)
      return -1;
      
    // Set status-icons
    setstatus("working");
    
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
      contentScript: "self.port.emit('message', window.prompt('" + _("edit") + "', '" + from.replace(/'/g, "\\'") + "'));"
      });
    asker.port.on('message', function(addonMessage) {
      
      if (addonMessage == null) {
        setstatus("idle");
        return -1;
      }
      var to = addonMessage;
      // Sow the edited page:
      selection.html = wikicode2html(to);
      
      //Start process of saving the change
      // Step I: get the source code
      var success = getsourcecode(article, from, to);
      // The Idea was to undo the change of the page if something went wrong 
      // but it does not work, since we don't get back the return value from the contentscript
      // until I don't I find a better solution,
      // I use the global var htmlfrom and the function resetview() instead.
      //if ( success == -1 )
      //   selection.html = from;
      });
}
  
  
// show an errormassage
function showerror(errormsg) {
    tabs.activeTab.attach({
      contentScript: "window.alert('" + errormsg + "');"
      });
}


// reset view
function resetview() {
	selection.html = htmlfrom;
}


// set the statusicon and after a few seconds, set it back to idle.
function setstatus(status) {
	if ( typeof(statuswidget) == "undefined" )
	  return;
	statuswidget.icon = "./qwe-" + status + ".png";
	statuswidget.tooltip = "QuickWikiEditor - " + _(status);
	if ( status != "working" && status != "idle" )
	  require("sdk/timers").setTimeout(function() {
		statuswidget.icon = "./qwe-idle.png";
		statuswidget.tooltip = "QuickWikiEditor - " + _("idle");
		},5000)
}


// Check if string contains any HTML-code
function check4html(string) {
    if ( string.indexOf("<") != -1 ) {
      showerror(_("unsupported_tag"));
      setstatus("fail");
      resetview();
      return -1;
    }
    else
      return 0;
}


// Convert HTML-Elements into Wikicode
// Supported for now: bold, wikilinks and encoded &<>
function html2wikicode(html) {
    console.log("html: "+html);
    // Replace blue wikilinks with [[foo|bar]]
    var tmp = html.replace(/<a href=\"\/wiki\/(.*)\" title=\".*\">/, '[[$1|').replace("</a>","]]");
    console.log("tmp: "+tmp);
    // Replace red wikilinks witch [[foo|bar]]
    tmp = tmp.replace(/<a href=\"\/w\/index.php\?title=(.*)&amp;action=edit&amp;redlink=1\" class=\"new\" title=\".*\">/, '[[$1|').replace("</a>","]]");
    // [[foo|foo]] -> [[foo]]
    tmp = tmp.replace(/\[\[(\w+)\|\1\]\]/, '\[\[$1\]\]');
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
    console.log("tmp: "+tmp);
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



// Extract domain & articlename out of url
function getarticlename(url) {
    article=new Object();
    for ( i in supportedwikis ) {
      domain = supportedwikis[i].substr(2); // remove "*." from beginning
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
      showerror(_("unsupported_site"));
      setstatus("fail");
      resetview();
      return -1;
    }
    // Extract articlename from URL
    if ( url.search("/wiki/") != -1 ) {
      article.name=url.substring(url.search("/wiki/")+6).split("#")[0];
    }
    // alternative URL-format de.wikipedia.org/w/index.php?title=FOO
    // make sure we're not in edit-mode
    else if ( url.search("title=") != -1 && url.search("action=edit") == -1 ) {
      article.name=url.substring(url.search("title=")+6).split(/[&#]/)[0];
    }
    // Can't parse URL, stop
    else {
      showerror(_("unreadable_url"))
      setstatus("fail");
      resetview();
      return -1;
    }
    return article;
}


// Set the edit-summary to be used
function generatesummary(from, to) {
      var summary;
      
      // Use summary the user set in the preferences
      if ( simpleprefs.prefs.summary != "_AUTO_" ) {
        summary = simpleprefs.prefs.summary;
      }
      // Autogenerate a summary
      else {
        // Remove identical words at the beginning
        var words = from.split(" ");
        var i=0;
        for ( ; i<words.length; i++ )  {
          word=words[i];
          if ( word.length > to.length )
             break;
          if ( to.slice(0,word.length) == word && 
              ( to[word.length] == " " || to[word.length] == undefined ) ) {
             to = to.slice(word.length,to.length);
             to = to.trim();
             from = from.slice(word.length,from.length);
             from = from.trim();
             }
          else
             break;
        }
        
        // Remove identical words at the end
        var words = from.split(" ");
        var i = words.length;
        while (i--) {
          var word = words[i];
          if ( word.length == 0 )
             continue;
          if ( word.length > to.length )
             break;
          if ( to.slice(to.length - word.length, to.length) == word &&
              ( to[to.length - word.length-1] == " " || to[to.length - word.length-1] == undefined )) {
             to = to.slice(0, to.length-word.length);
             to = to.trim();
             
             from = from.slice(0, from.length-word.length);
             from = from.trim();
             }
          else
             break;
        }
        // Nothing left means the only difference was only in white spaces
        if ( to == "" && from == "" ||
             // Check if from & to are identical except from white spaces
             to.replace(/[ \t]/g, "") == from.replace(/[ \t]/g, "") ) {
          summary = _("fixed space");
        }
        // test if only difference is punctuation
        else if ( to.replace(/[,;.!?]/g, "") == from.replace(/[,;.!?]/g, "") ) {
          summary = _("punctuation");
        }
        // 'to' is empty, means we removed a word
        else if ( to == "" ) {
          summary = _("removed word", from);
        }
        // 'from' is empty, means we added a word
        else if ( from == "" ) {
          summary = _("added missing word", to);
        }
        // Check if we create a wikilink
        else if ( "[[" + from + "]]" == to ) {
          summary = _("wikilink", to);
        }
        else {
          summary = from + " -> " + to;
        }
      }
      // ToDo: add third option, ask user to summary
      
      return summary;
}


// Get the sourcecode of the article
// then call next Step of edit-procedure
function getsourcecode(article, from, to) {
  var sourcecoderequest = Request({
    url: "https://" + article.lang + "." + article.site + "/w/api.php?format=json&action=query&titles=" 
         + article.name + "&prop=revisions&rvprop=content&redirects",
    onComplete: function (response) {
      if ( response.status != 200 ) {
         showerror(_("error_getting_code") + " " + _("statuscode") + ": " + response.status );
         setstatus("fail");
         resetview();
         return -1;
      }
      if ( typeof response.headers["MediaWiki-API-Error"] != "undefined" )  {
         showerror(_("error_getting_code") + " " + _("apicode") + ": "  + response.headers["MediaWiki-API-Error"] );
         setstatus("fail");
         resetview();
         return -1;
      }
      
      pages = response.json.query.pages;
      // The JSON includes a object named like the number of the article, witch we don't know
      // so use a loop to access it without needing the articlenumber
      for each ( var page in pages) {
         if ( typeof page.revisions == "undefined" ) {
           showerror(_("unknown_error_getting_code") + " (1) " + JSON.stringify(page).slice(0, 100));
           setstatus("fail");
           resetview();
           console.log(page);
           return -1;
         } else if ( typeof page.revisions[0] == "undefined" ) {
           showerror(_("unknown_error_getting_code") + " (2) " + JSON.stringify(page.revisions).slice(0, 100) );
           setstatus("fail");
           resetview();
           console.log(page.revisions);
           return -1;
         } else if ( typeof page.revisions[0]['*'] == "undefined" ) {
           showerror(_("unknown_error_getting_code") + " (3) " + JSON.stringify(page.revisions[0]).slice(0, 100));
           setstatus("fail");
           resetview();
           console.log(page.revisions[0]);
           return -1;
         }
         //Update articlename for the case that original articlename was a redirect
         article.name = page.title;
         sourcecode = page.revisions[0]['*'];
      }
      if ( typeof sourcecode == "undefined" ) {
         showerror(_("unknown_error_getting_code") + " (4) " + JSON.stringify(page.revisions[0]).slice(0, 100));
         setstatus("fail");
         resetview();
         console.log(page.revisions[0]);
         return -1;
      }
      // Edit the text
      sourcecode = edittext(sourcecode, from, to);
      if ( sourcecode == -1 )
        return -1;
      
      var summary = generatesummary(from, to);
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
      console.log(sourcecode);
      console.log(from);
      showerror(_("text_not_found"))
      setstatus("fail");
      resetview();
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
      showerror(_("text_not_unique"));
      setstatus("fail");
      resetview();
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
         showerror(_("error_getting_token") + " " + _("statuscode") + ": " + response.status );
         setstatus("fail");
         resetview();
         return -1;
      }
      if ( typeof response.headers["MediaWiki-API-Error"] != "undefined" )  {
         showerror(_("error_getting_token") + " " + _("apicode") + ": " + response.headers["MediaWiki-API-Error"] );
         setstatus("fail");
         resetview();
         return -1;
      }
      
      // Extract token from JSON
      var token = response.json;
      token = token.tokens.edittoken;
      if ( typeof token == "undefined" ) {
          showerror(_("unknown_error_getting_token"));
          setstatus("fail");
          resetview();
          return -1;
      }
      // Step III: save the article
      savepage(article, sourcecode, token, summary);
    }
  }).get();
}



// Save the article
function savepage(article, sourcecode, token, summary) {
  // Check if edits should be marked as minor
  var minor="";
  if ( simpleprefs.prefs.minor )
    minor="&minor";
  // Use multipart/form-data as contenttype alwasy because,
  // token has to be sent via POST since Mediawiki 1.24wmf19
  // and it is more efficient than application/x-www-form-urlencoded
  // for large pages & languages with non latin-script
  var boundary = "---------------------------8ce61ec834cf268";
  var contenttype = "multipart/form-data; boundary=" + boundary;
  var content = "\n\n" + "--" + boundary
			   + '\nContent-Disposition: form-data; name="token"'
			   + "\nContent-Type: text/plain; charset=UTF-8"
			   + "\nContent-Transfer-Encoding: 8bit"
			   + "\n\n"
			   + token + "\n"
			   + "--" + boundary
			   + '\nContent-Disposition: form-data; name="text"'
			   + "\nContent-Type: text/plain; charset=UTF-8"
			   + "\nContent-Transfer-Encoding: 8bit"
			   + "\n\n"
			   + sourcecode
			   + "\n";

  var editrequest = Request({
    url: "https://" + article.lang + "." + article.site + "/w/api.php?action=edit&redirects=&format=json&title="
      + article.name
      + "&summary=" + encodeURIComponent(summary)
      + minor,
    contentType: contenttype,
    content: content,
    onComplete: checksuccess
  }).post();
}


// Check for errors when saving page
function checksuccess(response) {
      if ( response.status != 200 ) {
         showerror(_("error_saving_page") + " " + _("statuscode") + ": " + response.status );
         // Set status-icons
         setstatus("fail");
         resetview();
      }
      if ( typeof response.headers["MediaWiki-API-Error"] != "undefined" ) {
         if ( response.headers["MediaWiki-API-Error"] == "protectedpage") {
            showerror(_("error_protectedpage"));
         }
         else {
            showerror(_("error_saving_page") + " " + _("apicode") + ": " + response.headers["MediaWiki-API-Error"] );
         }
         // Set status-icons to fail
         setstatus("fail");
         resetview();
      }
      else {
         // Set status-icons to success
         setstatus("success");
         console.log("saved!");
      }
}

