var d3 = require('d3');
require('d3-multiaxis-zoom')(d3);
var _ = require('lodash');
var inherits = require('inherits');
var Graph = require('../viz/graph');
var utils = require('lightning-client-utils');

d3.ForceEdgeBundling = function(){
        var data_nodes = {},        // {'nodeid':{'x':,'y':},..}
            data_edges = [],        // [{'source':'nodeid1', 'target':'nodeid2'},..]
            compatibility_list_for_edge = [],
            subdivision_points_for_edge = [],
            K = 0.1,                // global bundling constant controling edge stiffness
            S_initial = 0.1,        // init. distance to move points
            P_initial = 1,          // init. subdivision number
            P_rate    = 2,          // subdivision rate increase
            C = 4,                  // number of cycles to perform
            I_initial = 90,         // init. number of iterations for cycle
            I_rate = 0.333333,     // rate at which iteration number decreases i.e. 2/3
            compatibility_threshold = 0.6,
            invers_quadratic_mode  = false,
            eps = 1e-6;
             

        /*** Geometry Helper Methods ***/
        function vector_dot_product(p, q){
            return p.x * q.x + p.y * q.y;
        }

        function edge_as_vector(P){
            return {'x': data_nodes[P.target].x - data_nodes[P.source].x,
                    'y': data_nodes[P.target].y - data_nodes[P.source].y}
        }

        function edge_length(e){
            return Math.sqrt(Math.pow(data_nodes[e.source].x-data_nodes[e.target].x, 2) +
                             Math.pow(data_nodes[e.source].y-data_nodes[e.target].y, 2));
        }

        function custom_edge_length(e){
            return Math.sqrt(Math.pow(e.source.x - e.target.x, 2) + Math.pow(e.source.y - e.target.y, 2));
        }

        function edge_midpoint(e){
            var middle_x = (data_nodes[e.source].x + data_nodes[e.target].x) / 2.0;
            var middle_y = (data_nodes[e.source].y + data_nodes[e.target].y) / 2.0;
            return {'x': middle_x, 'y': middle_y};
        }

        function compute_divided_edge_length(e_idx){
            var length = 0;
            for(var i = 1; i < subdivision_points_for_edge[e_idx].length; i++){
                var segment_length = euclidean_distance(subdivision_points_for_edge[e_idx][i],
                                                        subdivision_points_for_edge[e_idx][i-1]);
                length += segment_length;
            }
            return length;
        }

        function euclidean_distance(p, q){
            return Math.sqrt(Math.pow(p.x-q.x, 2) + Math.pow(p.y-q.y, 2));
        }

        function project_point_on_line(p, Q)
        {   
            var L = Math.sqrt((Q.target.x - Q.source.x) * (Q.target.x - Q.source.x) + (Q.target.y - Q.source.y) * (Q.target.y - Q.source.y));
            var r = ((Q.source.y - p.y) * (Q.source.y - Q.target.y) - (Q.source.x - p.x) * (Q.target.x - Q.source.x)) / (L * L);
            
            return  {'x':(Q.source.x + r * (Q.target.x - Q.source.x)), 'y':(Q.source.y + r * (Q.target.y - Q.source.y))};
        }

        /*** ********************** ***/

        /*** Initialization Methods ***/
        function initialize_edge_subdivisions()
        {
            for(var i = 0; i < data_edges.length; i++)
             if(P_initial == 1)
                subdivision_points_for_edge[i] = []; //0 subdivisions
             else{
                subdivision_points_for_edge[i] = [];
                subdivision_points_for_edge[i].push(data_nodes[data_edges[i].source]);
                subdivision_points_for_edge[i].push(data_nodes[data_edges[i].target]);
            }
        }

        function initialize_compatibility_lists()
        {
            for(var i = 0; i < data_edges.length; i++)
                compatibility_list_for_edge[i] = []; //0 compatible edges.
        }

        function filter_self_loops(edgelist){
            var filtered_edge_list = [];
            for(var e=0; e < edgelist.length; e++){
                if(data_nodes[edgelist[e].source].x != data_nodes[edgelist[e].target].x  &&
                   data_nodes[edgelist[e].source].y != data_nodes[edgelist[e].target].y ){ //or smaller than eps
                    filtered_edge_list.push(edgelist[e]);

                }
            }

            return filtered_edge_list;
        }
        /*** ********************** ***/

        /*** Force Calculation Methods ***/
        function apply_spring_force(e_idx, i, kP){

            var prev = subdivision_points_for_edge[e_idx][i-1];
            var next = subdivision_points_for_edge[e_idx][i+1];
            var crnt = subdivision_points_for_edge[e_idx][i];

            var x = prev.x - crnt.x + next.x - crnt.x;
            var y = prev.y - crnt.y + next.y - crnt.y;
            
            x *= kP;
            y *= kP;
            
            return {'x' : x, 'y' : y};
        }

        function apply_electrostatic_force(e_idx, i , S){
            var sum_of_forces         = { 'x' : 0, 'y' : 0};
            var compatible_edges_list = compatibility_list_for_edge[e_idx];
            
            window.sbd = subdivision_points_for_edge;
            for(var oe = 0; oe < compatible_edges_list.length; oe++){
                var force = {'x': subdivision_points_for_edge[compatible_edges_list[oe]][i].x - subdivision_points_for_edge[e_idx][i].x,
                             'y': subdivision_points_for_edge[compatible_edges_list[oe]][i].y - subdivision_points_for_edge[e_idx][i].y};

                
                if((Math.abs(force.x) > eps)||(Math.abs(force.y) > eps)){
                
                var diff = ( 1 / Math.pow(custom_edge_length({'source':subdivision_points_for_edge[compatible_edges_list[oe]][i],
                                                              'target':subdivision_points_for_edge[e_idx][i]}),1));
                
                sum_of_forces.x += force.x*diff;
                sum_of_forces.y += force.y*diff;
                }
            } 
            return sum_of_forces;
        }


        function apply_resulting_forces_on_subdivision_points(e_idx, P, S){
            var kP = K/(edge_length(data_edges[e_idx])*(P+1)); // kP=K/|P|(number of segments), where |P| is the initial length of edge P.
                        // (length * (num of sub division pts - 1))
            var resulting_forces_for_subdivision_points = [{'x':0, 'y':0}];
            for(var i = 1; i < P+1; i++){ // exclude initial end points of the edge 0 and P+1
                var resulting_force     = {'x' : 0, 'y' : 0};
                
                spring_force            = apply_spring_force(e_idx, i , kP);
                electrostatic_force     = apply_electrostatic_force(e_idx, i, S);
                
                resulting_force.x   = S*(spring_force.x + electrostatic_force.x);
                resulting_force.y   = S*(spring_force.y + electrostatic_force.y);

                resulting_forces_for_subdivision_points.push(resulting_force);
            }
            resulting_forces_for_subdivision_points.push({'x':0, 'y':0});
            return resulting_forces_for_subdivision_points;
        }
        /*** ********************** ***/

        /*** Edge Division Calculation Methods ***/
        function update_edge_divisions(P){
            for(var e_idx=0; e_idx < data_edges.length; e_idx++){

                if( P == 1 ){
                    subdivision_points_for_edge[e_idx].push(data_nodes[data_edges[e_idx].source]); // source
                    subdivision_points_for_edge[e_idx].push(edge_midpoint(data_edges[e_idx])); // mid point
                    subdivision_points_for_edge[e_idx].push(data_nodes[data_edges[e_idx].target]); // target
                }else{

                    var divided_edge_length = compute_divided_edge_length(e_idx);
                    var segment_length      = divided_edge_length / (P+1);
                    var current_segment_length = segment_length;
                    var new_subdivision_points = [];
                    new_subdivision_points.push(data_nodes[data_edges[e_idx].source]); //source

                    for(var i = 1; i < subdivision_points_for_edge[e_idx].length; i++){
                        var old_segment_length = euclidean_distance(subdivision_points_for_edge[e_idx][i], subdivision_points_for_edge[e_idx][i-1]);

                        while(old_segment_length > current_segment_length){
                            var percent_position = current_segment_length / old_segment_length;
                            var new_subdivision_point_x = subdivision_points_for_edge[e_idx][i-1].x;
                            var new_subdivision_point_y = subdivision_points_for_edge[e_idx][i-1].y;

                            new_subdivision_point_x += percent_position*(subdivision_points_for_edge[e_idx][i].x - subdivision_points_for_edge[e_idx][i-1].x);
                            new_subdivision_point_y += percent_position*(subdivision_points_for_edge[e_idx][i].y - subdivision_points_for_edge[e_idx][i-1].y);
                            new_subdivision_points.push( {'x':new_subdivision_point_x, 
                                                          'y':new_subdivision_point_y });
                            
                            old_segment_length     -= current_segment_length;
                            current_segment_length  = segment_length;
                        }
                        current_segment_length -= old_segment_length;
                    }
                    new_subdivision_points.push(data_nodes[data_edges[e_idx].target]); //target
                    subdivision_points_for_edge[e_idx] = new_subdivision_points;
                }
            }
        }
        /*** ********************** ***/

        /*** Edge compatibility measures ***/
        function angle_compatibility(P, Q){
            var result = Math.abs(vector_dot_product(edge_as_vector(P),edge_as_vector(Q))/(edge_length(P)*edge_length(Q)));
            return result;
        }

        function scale_compatibility(P, Q){
            var lavg = (edge_length(P) + edge_length(Q))/2.0;
            var result = 2.0/(lavg/Math.min(edge_length(P),edge_length(Q)) + Math.max(edge_length(P), edge_length(Q))/lavg);
            return result;
        }

        function position_compatibility(P, Q){
            var lavg = (edge_length(P) + edge_length(Q))/2.0;
            var midP = {'x':(data_nodes[P.source].x + data_nodes[P.target].x)/2.0,
                        'y':(data_nodes[P.source].y + data_nodes[P.target].y)/2.0};
            var midQ = {'x':(data_nodes[Q.source].x + data_nodes[Q.target].x)/2.0,
                        'y':(data_nodes[Q.source].y + data_nodes[Q.target].y)/2.0};
            var result = lavg/(lavg + euclidean_distance(midP, midQ));
            return result;
        }

        function edge_visibility(P, Q){
            var I0 = project_point_on_line(data_nodes[Q.source], {'source':data_nodes[P.source],
                                                                  'target':data_nodes[P.target]});
            var I1 = project_point_on_line(data_nodes[Q.target], {'source':data_nodes[P.source], 
                                                                  'target':data_nodes[P.target]}); //send acutal edge points positions
            var midI = {'x':(I0.x + I1.x)/2.0, 
                        'y':(I0.y + I1.y)/2.0};
            var midP = {'x':(data_nodes[P.source].x + data_nodes[P.target].x)/2.0, 
                        'y':(data_nodes[P.source].y + data_nodes[P.target].y)/2.0};
            var result = Math.max(0, 1 - 2 * euclidean_distance(midP,midI)/euclidean_distance(I0,I1));
            return result;
        }

        function visibility_compatibility(P, Q){
            return Math.min(edge_visibility(P,Q), edge_visibility(Q,P));
        }

        function compatibility_score(P, Q){
            var result = (angle_compatibility(P,Q) * scale_compatibility(P,Q) * 
                          position_compatibility(P,Q) * visibility_compatibility(P,Q));

            return result;
        }

        function are_compatible(P, Q){
            //console.log('compatibility ' + P.source +' - '+ P.target + ' and ' + Q.source +' '+ Q.target);
            return (compatibility_score(P,Q) >= compatibility_threshold);
        }

        function compute_compatibility_lists()
        {
            for(e = 0; e < data_edges.length - 1; e++){
                for( oe = e + 1 ; oe < data_edges.length; oe++){ // don't want any duplicates
                    if(e == oe)
                        continue;
                    else{
                        if(are_compatible(data_edges[e],data_edges[oe])){
                            compatibility_list_for_edge[e].push(oe);
                            compatibility_list_for_edge[oe].push(e);
                        }
                    }
                }
            }
        }

        /*** ************************ ***/

        /*** Main Bundling Loop Methods ***/ 
        var forcebundle = function(){
            var S = S_initial;
            var I = I_initial;
            var P = P_initial;
            
            initialize_edge_subdivisions();
            initialize_compatibility_lists();
            update_edge_divisions(P);
            compute_compatibility_lists();
            for(var cycle=0; cycle < C; cycle++){
                for (var iteration = 0; iteration < I; iteration++){
                    var forces = [];
                    for(var edge = 0; edge < data_edges.length; edge++){
                        forces[edge] = apply_resulting_forces_on_subdivision_points(edge, P, S);
                    }
                    for(var e = 0; e < data_edges.length; e++){
                        for(var i=0; i < P + 1;i++){
                            subdivision_points_for_edge[e][i].x += forces[e][i].x;
                            subdivision_points_for_edge[e][i].y += forces[e][i].y;
                        }
                    }
                }
                //prepare for next cycle
                S = S / 2;
                P = P * 2;
                I = I_rate * I;
                
                update_edge_divisions(P);
            }
            return subdivision_points_for_edge;
        }
        /*** ************************ ***/


        /*** Getters/Setters Methods ***/ 
        forcebundle.nodes = function(nl){
            if(arguments.length == 0){
                return data_nodes;
            }
            else{
                data_nodes = nl;
            }
            return forcebundle;
        }

        forcebundle.edges = function(ll){
            if(arguments.length == 0){
                return data_edges;
            }
            else{
                data_edges = filter_self_loops(ll); //remove edges to from to the same point
            }
            return forcebundle;
        }

        forcebundle.bundling_stiffness = function(k){
            if(arguments.length == 0){
                return K;
            }
            else{
                K = k;
            }
            return forcebundle;
        }

        forcebundle.step_size = function(step){
            if(arguments.length == 0){
                return S_initial;
            }
            else{
                S_initial = step;
            }
            return forcebundle;
        }

        forcebundle.cycles = function(c){
            if(arguments.length == 0){
                return C;
            }
            else{
                C = c;
            }
            return forcebundle;
        }

        forcebundle.iterations = function(i){
            if(arguments.length == 0){
                return I_initial;
            }
            else{
                I_initial = i;
            }
            return forcebundle;
        }

        forcebundle.iterations_rate = function(i){
            if(arguments.length == 0){
                return I_rate;
            }
            else{
                I_rate = i;
            }
            return forcebundle;
        }

        forcebundle.subdivision_points_seed = function(p){
            if(arguments.length == 0){
                return P;
            }
            else{
                P = p;
            }
            return forcebundle;
        }

        forcebundle.subdivision_rate = function(r){
            if(arguments.length == 0){
                return P_rate;
            }
            else{
                P_rate = r;
            }
            return forcebundle;
        }

        forcebundle.compatibility_threshold = function(t){
            if(arguments.length == 0){
                return compatibility_threshold;
            }
            else{
                compatibility_threshold = t;
            }
            return forcebundle;
        }

        /*** ************************ ***/

    return forcebundle;
}


var margin = {
    top: 20,
    right: 20,
    bottom: 20,
    left: 45
};


var GraphBundled = function(selector, data, images, opts) {

    if(!opts) {
        opts = {};
    }

    this.opts = opts;

    this.width = (opts.width || $(selector).width()) - margin.left - margin.right;

    this.data = this._formatData(data);
    this.images = images || [];
    this.selector = selector;
    this.defaultFill = '#68a1e5';
    this.defaultSize = 8;
    this._init();

}

inherits(GraphBundled, require('events').EventEmitter);
inherits(GraphBundled, Graph);

module.exports = GraphBundled;

GraphBundled.prototype._init = function() {

    var data = this.data;
    var images = this.images;
    var width = this.width;
    var opts = this.opts;
    var selector = this.selector;
    var self = this;

    var nodes = data.nodes;
    var links = data.links;

    // if points are colored use gray, otherwise use our default
    var linkStrokeColor = nodes[0].c ? '#999' : '#A38EF3';

    // set opacity inversely proportional to number of links
    var linkStrokeOpacity = Math.max(1 - 0.0005 * links.length, 0.15);

    var xDomain = d3.extent(nodes, function(d) {
        return d.x;
    });

    var yDomain = d3.extent(nodes, function(d) {
        return d.y;
    });

    var imageCount = images.length;

    var ratio = 0;
    
    if (imageCount > 0) {
        var imwidth = (opts.imwidth || xDomain[1]);
        var imheight = (opts.imheight || yDomain[1]);
        ratio = imwidth / imheight;
        self.defaultFill = 'white';
        linkStrokeColor = 'white';
        xDomain = [0, imwidth];
        yDomain = [0, imheight];
    } else {
        ratio = Math.sqrt(2);
    }

    var height = width / ratio;

    var x = d3.scale.linear()
        .domain(xDomain)
        .range([width - 10, 0 + 10]);

    var y = d3.scale.linear()
        .domain(yDomain)
        .range([height - 10, 0 + 10]);

    var zoom = d3.behavior.zoom()
        .x(x)
        .y(y)
        .on('zoom', zoomed);

    var svg = d3.select(selector)
        .append('svg')
        .attr('width', width + margin.left + margin.right)
        .attr('height', height + margin.top + margin.bottom)
        .append("g")
        .call(zoom)
        .on('dblclick.zoom', null)
        .append("g");

    svg.append("rect")
        .attr("class", "overlay")
        .style("fill", "none")
        .style("pointer-events", "all")
        .attr("width", width + margin.left + margin.right)
        .attr("height", height + margin.top + margin.bottom);

    function zoomed() {
        
        svg.selectAll('.link')
            .attr('d', function(d) { return line(d); });

        svg.selectAll('.node')
           .attr('cx', function(d){ return x(d.x);})
           .attr('cy', function(d){ return y(d.y);});
    }

    if (imageCount > 0) {
        svg.append('svg:image')
            .attr('width', width)
            .attr('height', height);
        
        svg.select('image')
            .attr('xlink:href', utils.getThumbnail(this.images));
    }

    var toggleOpacity = 0;

    // array indicating links
    var linkedByIndex = {};
    var i
    for (i = 0; i < nodes.length; i++) {
        linkedByIndex[i + ',' + i] = 1;
    };
    links.forEach(function (d) {
        linkedByIndex[d.source + ',' + d.target] = 1;
    });

    // look up neighbor pairs
    function neighboring(a, b) {
        return linkedByIndex[a.i + ',' + b.i];
    }

    function selectedNodeOpacityIn() {
        d3.select(this).transition().duration(100).style("stroke", "rgb(30,30,30)")
    }

    function selectedNodeOpacityOut() {
        d3.select(this).transition().duration(50).style("stroke", "white")
    }

    var line = d3.svg.line()
        .x(function(d){ return d ? x(d.x) : null; })
        .y(function(d){ return d ? y(d.y) : null; })
        .interpolate('linear');
   
    var xscale = d3.mean(nodes, function(d) {return Math.abs(d.x)})
    var yscale = d3.mean(nodes, function(d) {return Math.abs(d.y)})
    var scale = (xscale + yscale) / 2
    
    setTimeout(function() {

        var fbundling = d3.ForceEdgeBundling()
            .nodes(nodes)
            .edges(links)
            .step_size(scale/1000)
            
        var results   = fbundling();    

        function connectedNodesOpacity() {

            if (toggleOpacity == 0) {
                // change opacity of all but the neighbouring nodes
                var d = d3.select(this).node().__data__;
                node.style("opacity", function (o) {
                    return neighboring(d, o) | neighboring(o, d) ? 1 : 0.2;
                });
                link.style("opacity", function (o) {
                    return d.i==o[0].i | d.i==o[o.length-1].i ? 0.9 : linkStrokeOpacity / 10;
                });
                toggleOpacity = 1;
            } else {
                // restore properties
                node.style("opacity", 1)
                link.style("opacity", linkStrokeOpacity);
                toggleOpacity = 0;
                }
        };


        var link = svg.selectAll('.link')
            .data(results)
          .enter().append('path')
            .classed('link', true)
            .attr('d', function(d) { return line(d); })
            .style('stroke-width', 1)
            .style('stroke', linkStrokeColor)
            .style('fill', 'none')
            .style('opacity', linkStrokeOpacity);

        //draw nodes
        var node = svg.selectAll('.node')
            .data(nodes)
          .enter()
            .append('circle')
            .classed('node', true)
            .attr('r', function(d) { return (d.s ? d.s : self.defaultSize); })
            .style('fill', function(d) { return (d.c ? d.c : self.defaultFill); })
            .attr('fill-opacity',0.9)
            .attr('stroke', 'white')
            .attr('stroke-width', 1)
            .attr('cx', function(d){ return x(d.x);})
            .attr('cy', function(d){ return y(d.y);})
            .on('mouseenter', selectedNodeOpacityIn)
            .on('mouseleave', selectedNodeOpacityOut)
            .on('click', connectedNodesOpacity);

    }, 10);


};

